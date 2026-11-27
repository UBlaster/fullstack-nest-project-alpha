import { EventEmitter } from 'node:events';
import { connect, ConsumeMessage, Channel } from 'amqplib';
import { PipelineProcessorService } from '../src/document-pipeline/pipeline-processor.service';
import { PipelineWorkerService } from '../src/worker/pipeline-worker.service';
import { QueueService } from '../src/queue/queue.service';
import { OutboxPublisherService } from '../src/outbox/outbox-publisher.service';
import { isolatedConfig } from './test-config';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

const job = {
	documentVersionId: 'version-123',
	stage: 'EMBED',
	inputHash: 'f'.repeat(64),
} as const;
const config = isolatedConfig({ RABBITMQ_URL: 'amqp://example.invalid' });

describe('pipeline publications', () => {
	it('routes five durable exponential retries back to the stage queue, strips extra fields and sanitizes DLQ', async () => {
		const channel = Object.assign(new EventEmitter(), {
			assertQueue: jest.fn().mockResolvedValue({}),
			close: jest.fn().mockResolvedValue(undefined),
			sendToQueue: jest.fn((_queue, _body, _options, confirm) => confirm(null)),
		});
		(connect as jest.Mock).mockResolvedValue(
			Object.assign(new EventEmitter(), {
				close: jest.fn().mockResolvedValue(undefined),
				createConfirmChannel: jest.fn().mockResolvedValue(channel),
			}),
		);
		const queue = new QueueService(config);
		try {
			const value = { ...job, privateText: 'do-not-forward' };
			for (let n = 1; n <= 5; n++) {
				await queue.publishPipeline('retry', value, 'run-' + n, n);
				expect(channel.assertQueue).toHaveBeenCalledWith(queue.pipelineRetryQueueNames[n - 1], {
					durable: true,
					arguments: expect.objectContaining({
						'x-dead-letter-routing-key': queue.pipelineQueueName,
						'x-dead-letter-strategy': 'at-least-once',
						'x-message-ttl': 1000 * 2 ** (n - 1),
					}),
				});
				const [name, body, options] = channel.sendToQueue.mock.calls[n - 1];
				expect(name).toBe(queue.pipelineRetryQueueNames[n - 1]);
				expect(JSON.parse(body.toString())).toEqual(job);
				expect(options).toMatchObject({
					persistent: true,
					mandatory: true,
					headers: { 'x-pipeline-retry': n },
				});
			}
			await queue.publishPipeline('dead', value, 'dead-id', 5, value.privateText);
			const [queueName, body] = channel.sendToQueue.mock.calls[5];
			expect(queueName).toBe(queue.pipelineDeadQueueName);
			expect(JSON.parse(body.toString())).toEqual({
				documentVersionId: job.documentVersionId,
				stage: job.stage,
				errorCode: 'FAILED',
			});
		} finally {
			await queue.onModuleDestroy();
		}
	});
});

describe('manual pipeline ACK', () => {
	let consume: (message: ConsumeMessage) => void;
	const channel = Object.assign(new EventEmitter(), {
		ack: jest.fn(),
		prefetch: jest.fn(),
		cancel: jest.fn(),
		close: jest.fn(),
		consume: jest.fn(async (_queue: string, callback: typeof consume) => {
			consume = callback;
			return { consumerTag: 'pipeline' };
		}),
	});
	const processor = { process: jest.fn(), recover: jest.fn().mockResolvedValue(0) };
	const outbox = { confirmPipelineDispatch: jest.fn() };
	const queue = {
		pipelineQueueName: 'test-pipeline',
		createConsumerChannel: jest.fn().mockResolvedValue(channel as unknown as Channel),
		quarantinePipelineMessage: jest.fn().mockResolvedValue(undefined),
	};
	let worker: PipelineWorkerService;
	const message = (payload: unknown) =>
		({
			properties: { headers: { 'x-pipeline-retry': 2 } },
			content: Buffer.from(JSON.stringify(payload)),
		}) as unknown as ConsumeMessage;

	beforeEach(async () => {
		channel.cancel.mockResolvedValue(undefined);
		channel.close.mockImplementation(async () => {
			channel.emit('close');
		});
		worker = new PipelineWorkerService(
			config,
			queue as unknown as QueueService,
			processor as unknown as PipelineProcessorService,
			outbox as unknown as OutboxPublisherService,
		);
		worker.start();
		await new Promise(setImmediate);
	});
	afterEach(async () => {
		await worker.close();
		channel.removeAllListeners();
		jest.clearAllMocks();
	});

	it('does not ACK a database failure with an unknown commit outcome', async () => {
		processor.process.mockRejectedValueOnce(new Error('unknown'));
		consume(message(job));
		await new Promise(setImmediate);
		expect(channel.ack).not.toHaveBeenCalled();
		expect(channel.close).toHaveBeenCalled();
	});

	it.each(['retry', 'dead'])('waits for %s confirmation before ACK', async (result) => {
		processor.process.mockResolvedValueOnce({ result, aggregateId: 'run-1' });
		let confirm!: () => void;
		outbox.confirmPipelineDispatch.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				confirm = resolve;
			}),
		);
		consume(message(job));
		await new Promise(setImmediate);
		expect(processor.process).toHaveBeenCalledWith(job, 2);
		expect(channel.ack).not.toHaveBeenCalled();
		expect(outbox.confirmPipelineDispatch).toHaveBeenCalledWith('run-1');
		confirm();
		await new Promise(setImmediate);
		expect(channel.ack).toHaveBeenCalledTimes(1);
	});

	it('leaves the message unacknowledged after an uncertain publish', async () => {
		processor.process.mockResolvedValueOnce({ result: 'retry', aggregateId: 'run-1' });
		outbox.confirmPipelineDispatch.mockRejectedValueOnce(new Error('unconfirmed'));
		consume(message(job));
		await new Promise(setImmediate);
		expect(channel.ack).not.toHaveBeenCalled();
		expect(channel.close).toHaveBeenCalled();
	});

	it('quarantines malformed input without forwarding its content', async () => {
		consume(message({ privateText: 'untrusted' }));
		await new Promise(setImmediate);
		expect(queue.quarantinePipelineMessage).toHaveBeenCalledWith();
		expect(processor.process).not.toHaveBeenCalled();
		expect(channel.ack).toHaveBeenCalledTimes(1);
	});
});
