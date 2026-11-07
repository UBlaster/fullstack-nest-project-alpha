import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExportJobStatus } from '@prisma/client';
import { Channel, ConsumeMessage } from 'amqplib';
import { ExportMaintenanceService } from './export-maintenance.service';
import { ExportProcessorService } from './export-processor.service';
import { ExportDatabaseError, ExportLeaseLostError, PermanentExportError } from './export-errors';
import { PrismaService } from '../prisma/prisma.service';
import { ExportQueueJob, exportQueueAttempts } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class WorkerRuntimeService {
	private readonly logger = new Logger(WorkerRuntimeService.name);
	private readonly pending = new Set<Promise<void>>();
	private channel?: Channel;
	private consumerTag?: string;
	private reconnectTimer?: NodeJS.Timeout;
	private connecting?: Promise<void>;
	private stopping = true;

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
					const pending = this.handleDelivery(channel, message).catch(() => {
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

	private async handleDelivery(channel: Channel, message: ConsumeMessage): Promise<void> {
		let job: ExportQueueJob;
		try {
			job = parseExportMessage(message);
		} catch {
			await this.queues.addDeadLetter(
				createDeadLetterPayload('invalid-message', 'invalid-message', 0, 'INVALID_FILTERS'),
			);
			channel.ack(message);
			return;
		}
		const queueJobId = message.properties.messageId as string;
		let failure: unknown;
		try {
			await this.processor.process(job);
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
			return;
		}
		if (current.queueJobId !== queueJobId) throw new Error('ExportMessageIdMismatch');
		if (
			current?.status === ExportJobStatus.COMPLETED ||
			current?.status === ExportJobStatus.CANCELLED
		) {
			channel.ack(message);
			return;
		}
		if (!failure && current.status !== ExportJobStatus.FAILED)
			throw new Error('ExportProcessorResolvedBeforeTerminalState');
		const attempts = Math.max(job.attemptsMade + 1, current?.attempts ?? 0);
		if (current?.status === ExportJobStatus.PROCESSING || failure instanceof ExportLeaseLostError) {
			await this.queues.deferExport(job.data, queueJobId, job.attemptsMade);
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
				await this.prisma.exportJob.updateMany({
					where: {
						id: current.id,
						queueJobId,
						status: ExportJobStatus.QUEUED,
						attempts: current.attempts,
						objectKey: current.objectKey,
					},
					data: { status: ExportJobStatus.FAILED, errorCode, finishedAt: new Date() },
				});
				const latest = await this.prisma.exportJob.findUniqueOrThrow({ where: { id: current.id } });
				if (latest.status !== ExportJobStatus.FAILED) {
					await this.queues.deferExport(job.data, queueJobId, job.attemptsMade);
					channel.ack(message);
					return;
				}
			}
			await this.queues.addDeadLetter(
				createDeadLetterPayload(job.data.exportJobId, queueJobId, attempts, errorCode),
			);
		} else {
			await this.queues.addRetry(job.data, queueJobId, attempts);
		}
		channel.ack(message);
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
