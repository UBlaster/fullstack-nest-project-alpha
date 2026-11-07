import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { Channel, ConsumeMessage } from 'amqplib';
import { QueueService } from '../src/queue/queue.service';
import { ExportProcessorService } from '../src/worker/export-processor.service';
import { ExportMaintenanceService } from '../src/worker/export-maintenance.service';
import {
	ExportDatabaseError,
	ExportLeaseLostError,
	PermanentExportError,
} from '../src/worker/export-errors';
import { WorkerRuntimeService } from '../src/worker/worker-runtime.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { isolatedConfig } from './test-config';

jest.mock('amqplib', () => ({ connect: jest.fn() }));
import { connect } from 'amqplib';

const payload = { exportJobId: 'test-export', schemaVersion: 1 } as const;
const message = (attemptsMade = 0): ConsumeMessage =>
	({
		content: Buffer.from(JSON.stringify(payload)),
		properties: { messageId: 'export-test-export', headers: { 'x-export-attempts': attemptsMade } },
	}) as unknown as ConsumeMessage;

describe('RabbitMQ publisher guarantees (no network)', () => {
	let channel: EventEmitter & Record<'assertQueue' | 'close' | 'sendToQueue', jest.Mock>;
	let connection: EventEmitter & Record<'createConfirmChannel' | 'close', jest.Mock>;
	let queue: QueueService;
	beforeEach(() => {
		channel = Object.assign(new EventEmitter(), {
			assertQueue: jest.fn().mockResolvedValue({}),
			close: jest.fn().mockResolvedValue(undefined),
			sendToQueue: jest.fn(),
		});
		connection = Object.assign(new EventEmitter(), {
			createConfirmChannel: jest.fn().mockResolvedValue(channel),
			close: jest.fn().mockResolvedValue(undefined),
		});
		(connect as jest.Mock).mockResolvedValue(connection);
		queue = new QueueService(isolatedConfig({ RABBITMQ_URL: 'amqp://example.invalid' }));
	});
	afterEach(async () => {
		await queue.onModuleDestroy();
		jest.clearAllMocks();
		jest.restoreAllMocks();
		jest.useRealTimers();
	});

	it('waits for a positive publisher confirm and sends persistent mandatory messages', async () => {
		channel.sendToQueue.mockReturnValue(false);
		let confirmed = false;
		const publishing = queue.addExport(payload, 'export-test-export').then(() => {
			confirmed = true;
		});
		await new Promise(setImmediate);
		expect(confirmed).toBe(false);
		expect(channel.sendToQueue.mock.calls[0][2]).toMatchObject({
			persistent: true,
			mandatory: true,
			messageId: 'export-test-export',
			headers: { 'x-export-attempts': 0 },
		});
		channel.sendToQueue.mock.calls[0][3](null);
		await publishing;
		expect(confirmed).toBe(true);
	});

	it('opens the broker lazily so an unavailable broker cannot block HTTP startup', () => {
		expect(connect).not.toHaveBeenCalled();
	});

	it('correlates returns per publication even when messageId is duplicated', async () => {
		const first = queue.addExport(payload, 'export-test-export');
		const second = queue.addExport(payload, 'export-test-export');
		const rejected = expect(first).rejects.toThrow('RabbitMQUnroutable');
		await new Promise(setImmediate);
		const [one, two] = channel.sendToQueue.mock.calls;
		expect(one[2].correlationId).not.toBe(two[2].correlationId);
		channel.emit('return', { properties: one[2] });
		two[3](null);
		one[3](null);
		await Promise.all([rejected, second]);
		expect(connect).toHaveBeenCalledTimes(1);
	});

	it('reconnects after a failed connection without exposing the broker error', async () => {
		(connect as jest.Mock).mockRejectedValueOnce(new Error('private connection detail'));
		await expect(queue.addExport(payload, 'export-test-export')).rejects.toThrow(
			'RabbitMQUnavailable',
		);
		channel.sendToQueue.mockImplementation((_name, _body, _options, callback) => callback(null));
		await queue.addExport(payload, 'export-test-export');
		expect(connect).toHaveBeenCalledTimes(2);
	});

	it('keeps retry and lease budgets and sends only sanitized DLQ metadata', async () => {
		channel.sendToQueue.mockImplementation((_name, _body, _options, callback) => callback(null));
		for (let attempt = 1; attempt < 5; attempt++) {
			await queue.addRetry(payload, 'export-test-export', attempt);
		}
		await queue.deferExport(payload, 'export-test-export', 3);
		const dead = {
			exportJobId: payload.exportJobId,
			sourceQueueJobId: 'export-test-export',
			attempts: 5,
			errorCode: 'RETRIES_EXHAUSTED',
		};
		await queue.addDeadLetter(dead);
		for (const [index, [name, body, options]] of channel.sendToQueue.mock.calls.entries()) {
			expect(name).toBe(
				index < 4
					? queue.retryQueueNames[index]
					: index === 4
						? queue.leaseQueueName
						: queue.deadQueueName,
			);
			expect(JSON.parse(body.toString())).toEqual(index === 5 ? dead : payload);
			expect(options).toMatchObject({
				persistent: true,
				mandatory: true,
				messageId: index === 5 ? 'dead-export-test-export' : 'export-test-export',
				headers: { 'x-export-attempts': index < 4 ? index + 1 : index === 4 ? 3 : 0 },
			});
		}
	});

	it('refuses new publications after shutdown', async () => {
		await queue.onModuleDestroy();
		await expect(queue.addExport(payload, 'export-test-export')).rejects.toThrow('RabbitMQClosing');
		expect(connect).not.toHaveBeenCalled();
	});

	it.each(['nack', 'return'])(
		'rejects %s instead of reporting a successful outbox publication',
		async (kind) => {
			channel.sendToQueue.mockImplementation((_name, _body, options, callback) => {
				if (kind === 'return') channel.emit('return', { properties: options });
				callback(kind === 'nack' ? new Error('broker detail') : null);
			});
			await expect(queue.addExport(payload, 'export-test-export')).rejects.toThrow(
				kind === 'nack' ? 'RabbitMQPublishFailed' : 'RabbitMQUnroutable',
			);
		},
	);

	it('declares durable quorum retries with exponential TTL and confirmed dead-lettering', async () => {
		channel.sendToQueue.mockImplementation((_queue, _body, _options, callback) => callback(null));
		await queue.addExport(payload, 'export-test-export');
		const declarations = channel.assertQueue.mock.calls;
		expect(declarations).toHaveLength(7);
		for (const [, options] of declarations) {
			expect(options).toMatchObject({
				durable: true,
				arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': -1 },
			});
		}
		for (const [index, name] of queue.retryQueueNames.entries()) {
			expect(declarations.find(([queueName]) => queueName === name)?.[1]).toMatchObject({
				durable: true,
				arguments: {
					'x-queue-type': 'quorum',
					'x-message-ttl': 5000 * 2 ** index,
					'x-dead-letter-routing-key': queue.queueName,
					'x-dead-letter-strategy': 'at-least-once',
					'x-overflow': 'reject-publish',
				},
			});
		}
		expect(declarations.find(([name]) => name === queue.leaseQueueName)?.[1]).toMatchObject({
			arguments: {
				'x-message-ttl': 2000,
				'x-dead-letter-exchange': '',
				'x-dead-letter-routing-key': queue.queueName,
				'x-dead-letter-strategy': 'at-least-once',
				'x-overflow': 'reject-publish',
			},
		});
	});

	it('bounds a missing publisher confirm', async () => {
		jest.useFakeTimers();
		const publishing = queue.addExport(payload, 'export-test-export');
		const result = expect(publishing).rejects.toThrow('RabbitMQConfirmTimeout');
		await jest.advanceTimersByTimeAsync(5000);
		await result;
		expect(channel.close).toHaveBeenCalledTimes(1);
	});

	it('rejects an outstanding publication immediately when its channel closes', async () => {
		const publishing = queue.addExport(payload, 'export-test-export');
		const result = expect(publishing).rejects.toThrow('RabbitMQPublishFailed');
		await new Promise(setImmediate);
		channel.emit('close');
		await result;
	});

	it.each(['connection', 'channel', 'topology'])(
		'bounds stalled %s setup and aborts the underlying socket',
		async (stage) => {
			jest.useFakeTimers();
			if (stage === 'connection') (connect as jest.Mock).mockReturnValueOnce(new Promise(() => {}));
			else if (stage === 'channel')
				connection.createConfirmChannel.mockReturnValue(new Promise(() => {}));
			else channel.assertQueue.mockReturnValue(new Promise(() => {}));
			const publishing = queue.addExport(payload, 'export-test-export');
			const result = expect(publishing).rejects.toThrow('RabbitMQUnavailable');
			await jest.advanceTimersByTimeAsync(5000);
			await result;
			expect((connect as jest.Mock).mock.calls[0][1].signal.aborted).toBe(true);
		},
	);
});

describe('RabbitMQ worker acknowledgements (no DB/network)', () => {
	const settle = async () => {
		await new Promise(setImmediate);
		await new Promise(setImmediate);
	};
	let runtime: WorkerRuntimeService;
	let channel: EventEmitter &
		Record<'prefetch' | 'consume' | 'cancel' | 'ack' | 'close', jest.Mock>;
	let processor: { process: jest.Mock };
	let prisma: {
		exportJob: { findUnique: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
	};
	let queues: Record<string, any>;
	let deliver: (message: ConsumeMessage | null) => void;
	beforeEach(() => {
		channel = Object.assign(new EventEmitter(), {
			prefetch: jest.fn().mockResolvedValue(undefined),
			consume: jest.fn().mockImplementation(async (_name, callback) => {
				deliver = callback;
				return { consumerTag: 'test' };
			}),
			cancel: jest.fn().mockResolvedValue(undefined),
			ack: jest.fn(),
			close: jest.fn().mockImplementation(async () => {
				channel.emit('close');
			}),
		});
		processor = { process: jest.fn().mockResolvedValue(undefined) };
		prisma = {
			exportJob: {
				findUnique: jest.fn().mockResolvedValue({
					status: 'COMPLETED',
					queueJobId: 'export-test-export',
					attempts: 1,
				}),
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				findUniqueOrThrow: jest.fn().mockResolvedValue({ status: 'FAILED' }),
			},
		};
		queues = {
			queueName: 'test',
			createConsumerChannel: jest.fn().mockResolvedValue(channel as unknown as Channel),
			addRetry: jest.fn().mockResolvedValue(undefined),
			deferExport: jest.fn().mockResolvedValue(undefined),
			addDeadLetter: jest.fn().mockResolvedValue(undefined),
		};
		runtime = new WorkerRuntimeService(
			new ConfigService(),
			processor as unknown as ExportProcessorService,
			{
				start: jest.fn(),
				stop: jest.fn().mockResolvedValue(undefined),
			} as unknown as ExportMaintenanceService,
			prisma as unknown as PrismaService,
			queues as QueueService,
		);
		runtime.start();
	});
	afterEach(async () => {
		await runtime.close();
		jest.restoreAllMocks();
		jest.useRealTimers();
	});

	it('uses manual acknowledgements with prefetch 2', async () => {
		await settle();
		expect(channel.prefetch).toHaveBeenCalledWith(2);
		expect(channel.consume.mock.calls[0][2]).toEqual({ noAck: false });
		deliver(message());
		await settle();
		expect(channel.ack).toHaveBeenCalledTimes(1);
	});

	it('does not ACK transient failures until the retry is confirmed', async () => {
		await settle();
		processor.process.mockRejectedValue(new Error('private error'));
		prisma.exportJob.findUnique.mockResolvedValue({
			status: 'QUEUED',
			queueJobId: 'export-test-export',
			attempts: 1,
		});
		let confirm!: () => void;
		queues.addRetry.mockReturnValue(
			new Promise<void>((resolve) => {
				confirm = resolve;
			}),
		);
		deliver(message());
		try {
			await settle();
			expect(channel.ack).not.toHaveBeenCalled();
		} finally {
			confirm();
		}
		await settle();
		expect(channel.ack).toHaveBeenCalledTimes(1);
	});

	it('keeps the original unacknowledged if DLQ publishing fails', async () => {
		await settle();
		prisma.exportJob.findUnique.mockResolvedValue({
			status: 'FAILED',
			queueJobId: 'export-test-export',
			attempts: 5,
			errorCode: 'RETRIES_EXHAUSTED',
		});
		queues.addDeadLetter.mockRejectedValue(new Error('broker disconnected'));
		deliver(message(4));
		await settle();
		expect(channel.ack).not.toHaveBeenCalled();
		expect(channel.close).toHaveBeenCalled();
	});

	it('defers a live lease without spending an attempt', async () => {
		await settle();
		processor.process.mockRejectedValue(new ExportLeaseLostError());
		prisma.exportJob.findUnique.mockResolvedValue({
			status: 'PROCESSING',
			queueJobId: 'export-test-export',
			attempts: 3,
		});
		deliver(message(2));
		await settle();
		expect(queues.deferExport).toHaveBeenCalledWith(payload, 'export-test-export', 2);
		expect(queues.addRetry).not.toHaveBeenCalled();
	});

	it.each(['COMPLETED', 'CANCELLED'])(
		'waits for the confirmed %s DB read before ACK',
		async (status) => {
			await settle();
			let confirm!: (value: unknown) => void;
			prisma.exportJob.findUnique.mockReturnValue(new Promise((resolve) => (confirm = resolve)));
			deliver(message());
			try {
				await settle();
				expect(channel.ack).not.toHaveBeenCalled();
			} finally {
				confirm({ status, queueJobId: 'export-test-export', attempts: 1 });
			}
			await settle();
			expect(channel.ack).toHaveBeenCalledTimes(1);
			expect(queues.addRetry).not.toHaveBeenCalled();
			expect(queues.addDeadLetter).not.toHaveBeenCalled();
		},
	);

	it.each(['deferExport', 'addDeadLetter'])(
		'waits for %s confirmation before ACK',
		async (method) => {
			await settle();
			processor.process.mockRejectedValue(new ExportLeaseLostError());
			if (method === 'addDeadLetter') processor.process.mockResolvedValue(undefined);
			prisma.exportJob.findUnique.mockResolvedValue({
				status: method === 'deferExport' ? 'PROCESSING' : 'FAILED',
				queueJobId: 'export-test-export',
				attempts: 3,
				errorCode: 'RETRIES_EXHAUSTED',
			});
			let confirm!: () => void;
			queues[method].mockReturnValue(new Promise<void>((resolve) => (confirm = resolve)));
			deliver(message(2));
			try {
				await settle();
				expect(queues[method]).toHaveBeenCalledTimes(1);
				expect(channel.ack).not.toHaveBeenCalled();
			} finally {
				confirm();
			}
			await settle();
			expect(channel.ack).toHaveBeenCalledTimes(1);
		},
	);

	it('confirms the final FAILED DB write and DLQ publication in that order before ACK', async () => {
		await settle();
		processor.process.mockRejectedValue(new Error('upload failed'));
		prisma.exportJob.findUnique.mockResolvedValue({
			id: 'test-export',
			status: 'QUEUED',
			queueJobId: 'export-test-export',
			attempts: 4,
			objectKey: null,
		});
		let commit!: (value: { count: number }) => void;
		let confirm!: () => void;
		prisma.exportJob.updateMany.mockReturnValue(new Promise((resolve) => (commit = resolve)));
		queues.addDeadLetter.mockReturnValue(new Promise<void>((resolve) => (confirm = resolve)));
		deliver(message(4));
		try {
			await settle();
			expect(prisma.exportJob.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
			);
			expect(queues.addDeadLetter).not.toHaveBeenCalled();
			expect(channel.ack).not.toHaveBeenCalled();
			commit({ count: 1 });
			await settle();
			expect(queues.addDeadLetter).toHaveBeenCalledWith({
				exportJobId: 'test-export',
				sourceQueueJobId: 'export-test-export',
				attempts: 5,
				errorCode: 'RETRIES_EXHAUSTED',
			});
			expect(channel.ack).not.toHaveBeenCalled();
		} finally {
			commit({ count: 1 });
			confirm();
		}
		await settle();
		expect(channel.ack).toHaveBeenCalledTimes(1);
		expect(queues.addRetry).not.toHaveBeenCalled();
	});

	it.each(['updateMany', 'findUniqueOrThrow'])(
		'preserves the last delivery if the terminal %s operation fails',
		async (operation) => {
			await settle();
			processor.process.mockRejectedValue(new Error('upload failed'));
			prisma.exportJob.findUnique.mockResolvedValue({
				id: 'test-export',
				status: 'QUEUED',
				queueJobId: 'export-test-export',
				attempts: 4,
			});
			prisma.exportJob[operation as 'updateMany' | 'findUniqueOrThrow'].mockRejectedValue(
				new Error('terminal DB response lost'),
			);
			deliver(message(4));
			await settle();
			expect(channel.ack).not.toHaveBeenCalled();
			expect(queues.addDeadLetter).not.toHaveBeenCalled();
			expect(channel.close).toHaveBeenCalled();
		},
	);

	it('defers a lost terminal-write race instead of publishing a false FAILED result', async () => {
		await settle();
		processor.process.mockRejectedValue(new Error('upload failed'));
		prisma.exportJob.findUnique.mockResolvedValue({
			id: 'test-export',
			status: 'QUEUED',
			queueJobId: 'export-test-export',
			attempts: 4,
		});
		prisma.exportJob.updateMany.mockResolvedValue({ count: 0 });
		prisma.exportJob.findUniqueOrThrow.mockResolvedValue({ status: 'PROCESSING' });
		deliver(message(4));
		await settle();
		expect(queues.addDeadLetter).not.toHaveBeenCalled();
		expect(queues.deferExport).toHaveBeenCalledWith(payload, 'export-test-export', 4);
		expect(channel.ack).toHaveBeenCalledTimes(1);
	});

	it('routes permanent failures directly to sanitized DLQ', async () => {
		await settle();
		processor.process.mockRejectedValue(new PermanentExportError('MEMBERSHIP_REVOKED'));
		prisma.exportJob.findUnique.mockResolvedValue({
			status: 'FAILED',
			queueJobId: 'export-test-export',
			attempts: 0,
			errorCode: 'MEMBERSHIP_REVOKED',
		});
		deliver(message());
		await settle();
		expect(queues.addDeadLetter).toHaveBeenCalledWith({
			exportJobId: 'test-export',
			sourceQueueJobId: 'export-test-export',
			attempts: 1,
			errorCode: 'MEMBERSHIP_REVOKED',
		});
		expect(queues.addRetry).not.toHaveBeenCalled();
	});

	it('quarantines malformed messages without invoking the processor or exposing the body', async () => {
		await settle();
		const invalid = message();
		invalid.content = Buffer.from('private malformed payload');
		deliver(invalid);
		await settle();
		expect(processor.process).not.toHaveBeenCalled();
		expect(queues.addDeadLetter).toHaveBeenCalledWith({
			exportJobId: 'invalid-message',
			sourceQueueJobId: 'invalid-message',
			attempts: 0,
			errorCode: 'INVALID_FILTERS',
		});
		expect(channel.ack).toHaveBeenCalledTimes(1);
	});

	it.each([
		['null body', null, 0, 'export-test-export'],
		[
			'unsupported schema',
			{ exportJobId: 'test-export', schemaVersion: 2 },
			0,
			'export-test-export',
		],
		['unsafe ID', { exportJobId: '../private', schemaVersion: 1 }, 0, 'export-../private'],
		['wrong messageId', payload, 0, 'export-other'],
		['negative budget', payload, -1, 'export-test-export'],
		['fractional budget', payload, 0.5, 'export-test-export'],
		['string budget', payload, '1', 'export-test-export'],
		['exhausted budget', payload, 5, 'export-test-export'],
	])(
		'quarantines %s without leaking input or touching domain rows',
		async (_name, body, attempts, id) => {
			await settle();
			const invalid = message();
			invalid.content = Buffer.from(JSON.stringify(body));
			invalid.properties.messageId = id as string;
			invalid.properties.headers = { 'x-export-attempts': attempts };
			deliver(invalid);
			await settle();
			expect(processor.process).not.toHaveBeenCalled();
			expect(prisma.exportJob.findUnique).not.toHaveBeenCalled();
			expect(prisma.exportJob.updateMany).not.toHaveBeenCalled();
			expect(queues.addDeadLetter).toHaveBeenCalledWith({
				exportJobId: 'invalid-message',
				sourceQueueJobId: 'invalid-message',
				attempts: 0,
				errorCode: 'INVALID_FILTERS',
			});
			expect(channel.ack).toHaveBeenCalledTimes(1);
		},
	);

	it.each(['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'])(
		'does not ACK an uncertain processor DB operation even if a later read returns %s',
		async (status) => {
			await settle();
			processor.process.mockRejectedValue(new ExportDatabaseError());
			prisma.exportJob.findUnique.mockResolvedValue({
				status,
				queueJobId: 'export-test-export',
				attempts: 4,
			});
			deliver(message(4));
			await settle();
			expect(channel.ack).not.toHaveBeenCalled();
			expect(queues.addRetry).not.toHaveBeenCalled();
			expect(queues.deferExport).not.toHaveBeenCalled();
			expect(queues.addDeadLetter).not.toHaveBeenCalled();
			expect(channel.close).toHaveBeenCalled();
		},
	);

	it('quarantines a confirmed missing row using only validated IDs and the existing budget', async () => {
		await settle();
		processor.process.mockRejectedValue(new PermanentExportError('INVALID_FILTERS'));
		prisma.exportJob.findUnique.mockResolvedValue(null);
		deliver(message(2));
		await settle();
		expect(queues.addDeadLetter).toHaveBeenCalledWith({
			exportJobId: 'test-export',
			sourceQueueJobId: 'export-test-export',
			attempts: 2,
			errorCode: 'INVALID_FILTERS',
		});
		expect(prisma.exportJob.updateMany).not.toHaveBeenCalled();
		expect(queues.addRetry).not.toHaveBeenCalled();
		expect(channel.ack).toHaveBeenCalledTimes(1);
	});

	it('does not confuse a DB lookup failure with a missing row', async () => {
		await settle();
		prisma.exportJob.findUnique.mockRejectedValue(new Error('private DB detail'));
		deliver(message());
		await settle();
		expect(queues.addDeadLetter).not.toHaveBeenCalled();
		expect(channel.ack).not.toHaveBeenCalled();
		expect(channel.close).toHaveBeenCalled();
	});

	it.each(['addRetry', 'deferExport'])(
		'leaves the original unacknowledged when %s fails',
		async (method) => {
			await settle();
			processor.process.mockRejectedValue(
				method === 'deferExport' ? new ExportLeaseLostError() : new Error('upload failed'),
			);
			prisma.exportJob.findUnique.mockResolvedValue({
				status: method === 'deferExport' ? 'PROCESSING' : 'QUEUED',
				queueJobId: 'export-test-export',
				attempts: 1,
			});
			queues[method].mockRejectedValue(new Error('publish outcome unknown'));
			deliver(message());
			await settle();
			expect(channel.ack).not.toHaveBeenCalled();
			expect(channel.close).toHaveBeenCalled();
		},
	);

	it('does not ACK a processor resolve that has no confirmed terminal state', async () => {
		await settle();
		prisma.exportJob.findUnique.mockResolvedValue({
			status: 'QUEUED',
			queueJobId: 'export-test-export',
		});
		deliver(message());
		await settle();
		expect(channel.ack).not.toHaveBeenCalled();
		expect(channel.close).toHaveBeenCalled();
	});

	it('drains old handlers before reconnecting and ACKs only on the original channel', async () => {
		await settle();
		let release!: () => void;
		processor.process.mockReturnValue(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		deliver(message());
		deliver(message());
		await settle();
		const next = Object.assign(new EventEmitter(), {
			prefetch: jest.fn().mockResolvedValue(undefined),
			consume: jest.fn().mockResolvedValue({ consumerTag: 'next' }),
			cancel: jest.fn().mockResolvedValue(undefined),
			ack: jest.fn(),
			close: jest.fn().mockImplementation(async () => {
				next.emit('close');
			}),
		});
		queues.createConsumerChannel.mockResolvedValue(next);
		jest.useFakeTimers({ doNotFake: ['setImmediate'] });
		try {
			channel.emit('close');
			await jest.advanceTimersByTimeAsync(1000);
			expect(queues.createConsumerChannel).toHaveBeenCalledTimes(1);
			release();
			await settle();
			expect(queues.createConsumerChannel).toHaveBeenCalledTimes(2);
			expect(channel.ack).toHaveBeenCalledTimes(2);
			expect(next.ack).not.toHaveBeenCalled();
		} finally {
			release();
		}
	});

	it('closes a channel that finishes opening during shutdown without starting a consumer', async () => {
		await settle();
		await runtime.close();
		channel.consume.mockClear();
		channel.close.mockClear();
		let release!: (value: Channel) => void;
		queues.createConsumerChannel.mockReturnValue(
			new Promise<Channel>((resolve) => {
				release = resolve;
			}),
		);
		runtime.start();
		await settle();
		const closing = runtime.close();
		release(channel as unknown as Channel);
		await closing;
		expect(channel.consume).not.toHaveBeenCalled();
		expect(channel.close).toHaveBeenCalledTimes(1);
	});
});
