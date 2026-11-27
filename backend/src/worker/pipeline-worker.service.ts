import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SpanKind } from '@opentelemetry/api';
import type { Channel, ConsumeMessage } from 'amqplib';
import { PipelineProcessorService } from '../document-pipeline/pipeline-processor.service';
import { withMessageContext } from '../observability/carrier';
import { logEvent } from '../observability/logger';
import { meter, secondsHistogram, withSpan } from '../observability/telemetry';
import { OutboxPublisherService } from '../outbox/outbox-publisher.service';
import { PipelineJob, parsePipelineJob, pipelineRetries } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { RabbitConsumer } from '../queue/rabbit-consumer';

const deliveries = meter.createCounter('pipeline.stage.deliveries');
const processing = meter.createHistogram('pipeline.stage.processing', secondsHistogram);

@Injectable()
export class PipelineWorkerService {
	private readonly consumer: RabbitConsumer;
	private readonly recoverIntervalMs: number;
	private recoveryTimer?: NodeJS.Timeout;
	private recovering?: Promise<void>;

	constructor(
		config: ConfigService,
		private readonly queue: QueueService,
		private readonly processor: PipelineProcessorService,
		private readonly outbox: OutboxPublisherService,
	) {
		this.consumer = new RabbitConsumer(
			queue.pipelineQueueName,
			() => queue.createConsumerChannel(true),
			(channel, message) => this.consume(channel, message),
		);
		this.recoverIntervalMs = Number(config.get('PIPELINE_RECOVERY_INTERVAL_MS') ?? 10_000);
		if (!Number.isSafeInteger(this.recoverIntervalMs) || this.recoverIntervalMs <= 0)
			throw new Error('PIPELINE_RECOVERY_INTERVAL_MS must be positive');
	}

	start(): void {
		if (this.recoveryTimer) return;
		this.consumer.start();
		const recover = () => {
			if (this.recovering) return;
			this.recovering = this.processor
				.recover()
				.then(() => {})
				.catch(() => logEvent('warn', 'pipeline.recovery.failed'))
				.finally(() => {
					this.recovering = undefined;
				});
		};
		this.recoveryTimer = setInterval(recover, this.recoverIntervalMs);
		this.recoveryTimer.unref();
		recover();
	}

	async close(): Promise<void> {
		clearInterval(this.recoveryTimer);
		this.recoveryTimer = undefined;
		await Promise.all([this.consumer.close(), this.recovering]);
	}

	private consume(channel: Channel, message: ConsumeMessage): Promise<void> {
		return withMessageContext(message.properties.headers, () =>
			withSpan(
				'rabbitmq.consume',
				async () => {
					let job: PipelineJob;
					const retryNumber: unknown = message.properties.headers?.['x-pipeline-retry'] ?? 0;
					try {
						job = parsePipelineJob(JSON.parse(message.content.toString('utf8')));
						if (
							typeof retryNumber !== 'number' ||
							!Number.isInteger(retryNumber) ||
							retryNumber < 0 ||
							retryNumber > pipelineRetries
						)
							throw new Error('InvalidPipelineRetry');
					} catch {
						await this.queue.quarantinePipelineMessage();
						channel.ack(message);
						return;
					}
					await withSpan('pipeline.' + job.stage, async (span) => {
						const start = performance.now();
						let result = 'unacknowledged';
						try {
							const outcome = await this.processor.process(job, retryNumber);
							if (outcome.result === 'retry' || outcome.result === 'dead') {
								if (!outcome.aggregateId) throw new Error('MissingPipelineDispatch');
								await this.outbox.confirmPipelineDispatch(outcome.aggregateId);
							}
							channel.ack(message);
							result = outcome.result;
						} finally {
							const durationMs = performance.now() - start;
							const attributes = { stage: job.stage, result };
							deliveries.add(1, attributes);
							processing.record(durationMs / 1000, attributes);
							span.setAttributes(attributes);
							logEvent(result === 'unacknowledged' ? 'warn' : 'info', 'pipeline.stage', {
								...attributes,
								durationMs,
								documentVersionId: job.documentVersionId,
							});
						}
					});
				},
				{
					kind: SpanKind.CONSUMER,
					attributes: {
						'messaging.system': 'rabbitmq',
						'messaging.destination.name': this.queue.pipelineQueueName,
					},
				},
			),
		);
	}
}
