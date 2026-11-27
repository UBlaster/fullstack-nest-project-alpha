import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExportJobStatus } from '@prisma/client';
import { Channel, ConsumeMessage } from 'amqplib';
import { BatchObservableResult, SpanKind, trace } from '@opentelemetry/api';
import { withMessageContext } from '../observability/carrier';
import { getRequestId } from '../diagnostics/request-context';
import { logEvent } from '../observability/logger';
import { meter, secondsHistogram, withSpan } from '../observability/telemetry';
import { recordFinishedExport } from '../exports/export-metrics';
import { ExportMaintenanceService } from './export-maintenance.service';
import { ExportProcessorService } from './export-processor.service';
import { ExportDatabaseError, ExportLeaseLostError, PermanentExportError } from './export-errors';
import { PrismaService } from '../prisma/prisma.service';
import { ExportQueueJob, exportQueueAttempts } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';

type Disposition = 'completed' | 'cancelled' | 'retry' | 'deferred' | 'dead';
const processing = meter.createHistogram('export.queue.processing', secondsHistogram);
const queueWait = meter.createHistogram('export.queue.wait', secondsHistogram);
const queueDepth = meter.createObservableGauge('export.queue.depth');
const oldestAge = meter.createObservableGauge('export.queue.oldest_job_age', { unit: 's' });
const gauges = [queueDepth, oldestAge];

@Injectable()
export class WorkerRuntimeService {
	private readonly logger = new Logger(WorkerRuntimeService.name);
	private readonly pending = new Set<Promise<void>>();
	private channel?: Channel;
	private consumerTag?: string;
	private reconnectTimer?: NodeJS.Timeout;
	private connecting?: Promise<void>;
	private stopping = true;
	private readingGauges = false;

	constructor(
		_config: ConfigService,
		private readonly processor: ExportProcessorService,
		private readonly maintenance: ExportMaintenanceService,
		private readonly prisma: PrismaService,
		private readonly queues: QueueService,
	) {}

	start(): void {
		if (!this.stopping) return;
		this.stopping = false;
		meter.addBatchObservableCallback(this.observeBacklog, gauges);
		this.maintenance.start();
		this.connect();
	}

	private connect(): void {
		if (this.stopping || this.connecting || this.channel) return;
		this.connecting = this.consume()
			.catch(() => {
				this.logger.warn('RabbitMQ consumer unavailable; reconnecting');
				this.scheduleReconnect();
			})
			.finally(() => {
				this.connecting = undefined;
			});
	}

	private async consume(): Promise<void> {
		await Promise.allSettled([...this.pending]);
		if (this.stopping) return;
		const channel = await this.queues.createConsumerChannel();
		let closed = false;
		channel.on('error', () => this.logger.warn('RabbitMQ consumer channel error'));
		channel.on('close', () => {
			closed = true;
			if (this.channel === channel) {
				this.channel = undefined;
				this.consumerTag = undefined;
				this.scheduleReconnect();
			}
		});
		this.channel = channel;
		try {
			await channel.prefetch(2);
			if (closed) throw new Error('RabbitMQConsumerClosed');
			if (this.stopping) {
				await channel.close();
				return;
			}
			const consumer = await channel.consume(
				this.queues.queueName,
				(message) => {
					if (!message) {
						void channel.close().catch(() => {});
						return;
					}
					if (this.stopping || closed) return;
					const pending = this.consumeMessage(channel, message).catch(() => {
						this.logger.warn('RabbitMQ delivery unfinished; requeueing on channel close');
						return channel.close().catch(() => {});
					});
					this.pending.add(pending);
					void pending.finally(() => this.pending.delete(pending));
				},
				{ noAck: false },
			);
			if (closed) throw new Error('RabbitMQConsumerClosed');
			this.consumerTag = consumer.consumerTag;
		} catch (error) {
			await channel.close().catch(() => {});
			throw error;
		}
	}

	private scheduleReconnect(): void {
		if (this.stopping || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect();
		}, 1_000);
		this.reconnectTimer.unref();
	}

	async close(force = false): Promise<void> {
		this.stopping = true;
		meter.removeBatchObservableCallback(this.observeBacklog, gauges);
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		await this.connecting;
		const channel = this.channel;
		if (channel && this.consumerTag) await channel.cancel(this.consumerTag).catch(() => {});
		if (force) await channel?.close().catch(() => {});
		await Promise.allSettled([...this.pending]);
		await this.maintenance.stop();
		if (!force) await channel?.close().catch(() => {});
		this.channel = undefined;
		this.consumerTag = undefined;
	}

	private readonly observeBacklog = async (result: BatchObservableResult) => {
		if (this.readingGauges || this.stopping) return;
		this.readingGauges = true;
		try {
			await Promise.allSettled([
				this.queues.readyDepths().then((depths) => {
					if (!depths) return;
					result.observe(queueDepth, depths.ready, { destination: 'ready' });
					result.observe(queueDepth, depths.dead, { destination: 'dead' });
				}),
				this.prisma.exportJob
					.aggregate({
						where: { status: ExportJobStatus.QUEUED },
						_min: { createdAt: true },
					})
					.then(({ _min }) => {
						result.observe(
							oldestAge,
							_min.createdAt ? Math.max(0, Date.now() - _min.createdAt.getTime()) / 1000 : 0,
						);
					}),
			]);
		} finally {
			this.readingGauges = false;
		}
	};

	private consumeMessage(channel: Channel, message: ConsumeMessage): Promise<void> {
		const headers = message.properties.headers;
		const received = Date.now();
		return withMessageContext(headers, () => {
			const sent: unknown = headers?.['x-export-sent-ms'];
			if (typeof sent === 'number' && Number.isSafeInteger(sent) && sent > 0 && sent <= received) {
				trace
					.getTracer('workspace-docs')
					.startSpan('rabbitmq.wait', {
						startTime: sent,
						attributes: { 'messaging.system': 'rabbitmq', 'request.id': getRequestId() },
					})
					.end(received);
				queueWait.record((received - sent) / 1000);
			}
			return withSpan(
				'rabbitmq.consume',
				async (span) => {
					let result: Disposition | 'unacknowledged' = 'unacknowledged';
					const started = performance.now();
					try {
						result = await this.handleDelivery(channel, message);
					} finally {
						const durationMs = performance.now() - started;
						span.setAttribute('result', result);
						processing.record(durationMs / 1000, { result });
						logEvent(result === 'unacknowledged' ? 'warn' : 'info', 'rabbitmq.consume', {
							result,
							durationMs,
						});
					}
				},
				{ kind: SpanKind.CONSUMER, attributes: { 'messaging.system': 'rabbitmq' } },
			);
		});
	}

	private async handleDelivery(channel: Channel, message: ConsumeMessage): Promise<Disposition> {
		let job: ExportQueueJob;
		try {
			job = parseExportMessage(message);
		} catch {
			await this.queues.addDeadLetter(
				createDeadLetterPayload('invalid-message', 'invalid-message', 0, 'INVALID_FILTERS'),
			);
			channel.ack(message);
			return 'dead';
		}
		const queueJobId = message.properties.messageId as string;
		let failure: unknown;
		try {
			await withSpan('export.process', () => this.processor.process(job));
		} catch (error) {
			failure = error;
		}
		if (failure instanceof ExportDatabaseError) throw failure;
		const current = await this.prisma.exportJob.findUnique({ where: { id: job.data.exportJobId } });
		if (!current) {
			await this.queues.addDeadLetter(
				createDeadLetterPayload(
					job.data.exportJobId,
					queueJobId,
					job.attemptsMade,
					'INVALID_FILTERS',
				),
			);
			channel.ack(message);
			return 'dead';
		}
		if (current.queueJobId !== queueJobId) throw new Error('ExportMessageIdMismatch');
		if (
			current?.status === ExportJobStatus.COMPLETED ||
			current?.status === ExportJobStatus.CANCELLED
		) {
			channel.ack(message);
			return current.status === ExportJobStatus.COMPLETED ? 'completed' : 'cancelled';
		}
		if (!failure && current.status !== ExportJobStatus.FAILED)
			throw new Error('ExportProcessorResolvedBeforeTerminalState');
		const attempts = Math.max(job.attemptsMade + 1, current?.attempts ?? 0);
		let disposition: Disposition;
		if (current?.status === ExportJobStatus.PROCESSING || failure instanceof ExportLeaseLostError) {
			await this.queues.deferExport(job.data, queueJobId, job.attemptsMade);
			disposition = 'deferred';
		} else if (
			current?.status === ExportJobStatus.FAILED ||
			failure instanceof PermanentExportError ||
			attempts >= exportQueueAttempts
		) {
			const errorCode =
				current?.status === ExportJobStatus.FAILED
					? current.errorCode
					: failure instanceof PermanentExportError
						? failure.code
						: 'RETRIES_EXHAUSTED';
			if (current?.status === ExportJobStatus.QUEUED) {
				const failed = await this.prisma.exportJob.updateMany({
					where: {
						id: current.id,
						queueJobId,
						status: ExportJobStatus.QUEUED,
						attempts: current.attempts,
						objectKey: current.objectKey,
					},
					data: { status: ExportJobStatus.FAILED, errorCode, finishedAt: new Date() },
				});
				if (failed.count) recordFinishedExport(current.createdAt, 'failed');
				const latest = await this.prisma.exportJob.findUniqueOrThrow({ where: { id: current.id } });
				if (latest.status !== ExportJobStatus.FAILED) {
					await this.queues.deferExport(job.data, queueJobId, job.attemptsMade);
					channel.ack(message);
					return 'deferred';
				}
			}
			await this.queues.addDeadLetter(
				createDeadLetterPayload(job.data.exportJobId, queueJobId, attempts, errorCode),
			);
			disposition = 'dead';
		} else {
			await this.queues.addRetry(job.data, queueJobId, attempts);
			disposition = 'retry';
		}
		channel.ack(message);
		return disposition;
	}
}

export function parseExportMessage(message: ConsumeMessage): ExportQueueJob {
	const payload: unknown = JSON.parse(message.content.toString('utf8'));
	const attemptsMade: unknown = message.properties.headers?.['x-export-attempts'] ?? 0;
	if (
		typeof payload !== 'object' ||
		payload === null ||
		!('exportJobId' in payload) ||
		typeof payload.exportJobId !== 'string' ||
		!/^[a-zA-Z0-9-]{1,200}$/.test(payload.exportJobId) ||
		!('schemaVersion' in payload) ||
		payload.schemaVersion !== 1 ||
		message.properties.messageId !== 'export-' + payload.exportJobId ||
		typeof attemptsMade !== 'number' ||
		!Number.isInteger(attemptsMade) ||
		attemptsMade < 0 ||
		attemptsMade >= exportQueueAttempts
	)
		throw new Error('InvalidExportMessage');
	return { data: { exportJobId: payload.exportJobId, schemaVersion: 1 }, attemptsMade };
}

export function createDeadLetterPayload(
	exportJobId: string,
	sourceQueueJobId: string,
	attempts: number,
	errorCode: string | null,
) {
	const allowed = ['INVALID_FILTERS', 'MEMBERSHIP_REVOKED', 'RETRIES_EXHAUSTED'];
	return {
		exportJobId,
		sourceQueueJobId,
		attempts,
		errorCode: errorCode && allowed.includes(errorCode) ? errorCode : 'INTERNAL_ERROR',
	};
}
