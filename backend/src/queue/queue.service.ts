import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel, ChannelModel, ConfirmChannel, connect, Options } from 'amqplib';
import { SpanKind } from '@opentelemetry/api';
import { messageHeaders } from '../observability/carrier';
import { logEvent } from '../observability/logger';
import { meter, withSpan } from '../observability/telemetry';
import {
	ExportDeadLetterPayload,
	ExportQueuePayload,
	exportQueueAttempts,
	exportQueueBackoffMs,
	PipelineDestination,
	PipelineJob,
	pipelineRetries,
	parsePipelineJob,
} from './queue.constants';

type Destination = 'ready' | 'retry' | 'lease' | 'dead';
const publications = meter.createCounter('export.queue.publications');
const pipelinePublications = meter.createCounter('pipeline.queue.publications');

@Injectable()
export class QueueService implements OnModuleDestroy {
	private readonly logger = new Logger(QueueService.name);
	readonly queueName: string;
	readonly deadQueueName: string;
	readonly leaseQueueName: string;
	readonly retryQueueNames: string[];
	readonly pipelineQueueName: string;
	readonly pipelineDeadQueueName: string;
	readonly pipelineRetryQueueNames: string[];
	private readonly pipelineBackoffMs: number;
	private pipelineTopology?: { channel: ConfirmChannel; ready: Promise<void> };
	private readonly url: string;
	private readonly timeoutMs: number;
	private readonly backoffMs: number;
	private readonly leaseDelayMs: number;
	private connection?: ChannelModel;
	private connectionAbort?: AbortController;
	private publisher?: ConfirmChannel;
	private opening?: Promise<ConfirmChannel>;
	private closing = false;
	private readonly publications = new Map<string, { returned: boolean }>();

	constructor(config: ConfigService) {
		this.url = config.get<string>('RABBITMQ_URL') ?? '';
		if (!this.url) throw new Error('RABBITMQ_URL is required');
		this.queueName = config.get<string>('EXPORT_QUEUE_NAME') ?? 'workspace-exports';
		this.deadQueueName = config.get<string>('EXPORT_DLQ_NAME') ?? 'workspace-exports-dead';
		this.leaseQueueName = `${this.queueName}-lease`;
		this.retryQueueNames = Array.from(
			{ length: exportQueueAttempts - 1 },
			(_, index) => `${this.queueName}-retry-${index + 1}`,
		);
		this.pipelineQueueName =
			config.get<string>('PIPELINE_QUEUE_NAME') ?? `${this.queueName}-pipeline`;
		this.pipelineDeadQueueName = `${this.pipelineQueueName}-dead`;
		this.pipelineRetryQueueNames = Array.from(
			{ length: pipelineRetries },
			(_, index) => `${this.pipelineQueueName}-retry-${index + 1}`,
		);
		const names = [
			this.queueName,
			this.deadQueueName,
			this.leaseQueueName,
			...this.retryQueueNames,
			this.pipelineQueueName,
			this.pipelineDeadQueueName,
			...this.pipelineRetryQueueNames,
		];
		if (new Set(names).size !== names.length) throw new Error('Queue names must be distinct');
		this.timeoutMs = this.positiveInteger(config, 'RABBITMQ_TIMEOUT_MS', 5_000);
		this.backoffMs = this.positiveInteger(config, 'EXPORT_RETRY_BACKOFF_MS', exportQueueBackoffMs);
		this.leaseDelayMs = this.positiveInteger(config, 'EXPORT_LEASE_DELAY_MS', 2_000);
		this.pipelineBackoffMs = this.positiveInteger(config, 'PIPELINE_RETRY_BACKOFF_MS', 1_000);
	}

	addExport(payload: ExportQueuePayload, queueJobId: string): Promise<void> {
		return this.publish('ready', this.queueName, payload, queueJobId, 0);
	}

	addRetry(payload: ExportQueuePayload, queueJobId: string, attemptsMade: number): Promise<void> {
		const queue = this.retryQueueNames[attemptsMade - 1];
		if (!queue) throw new Error('Invalid export retry attempt');
		return this.publish('retry', queue, payload, queueJobId, attemptsMade);
	}

	deferExport(
		payload: ExportQueuePayload,
		queueJobId: string,
		attemptsMade: number,
	): Promise<void> {
		return this.publish('lease', this.leaseQueueName, payload, queueJobId, attemptsMade);
	}

	addDeadLetter(payload: ExportDeadLetterPayload): Promise<void> {
		return this.publish('dead', this.deadQueueName, payload, `dead-${payload.sourceQueueJobId}`, 0);
	}

	async publishPipeline(
		delivery: PipelineDestination,
		job: PipelineJob,
		messageId: string,
		retryNumber = 0,
		errorCode?: string,
	): Promise<void> {
		const clean = parsePipelineJob(job);
		if (delivery === 'dead') {
			const allowed = [
				'RETRIES_EXHAUSTED',
				'MEMBERSHIP_REVOKED',
				'INVALID_SOURCE',
				'INVALID_EMBEDDING',
			];
			return this.publish(
				'dead',
				this.pipelineDeadQueueName,
				{
					documentVersionId: clean.documentVersionId,
					stage: clean.stage,
					errorCode: errorCode && allowed.includes(errorCode) ? errorCode : 'FAILED',
				},
				messageId,
				retryNumber,
				true,
			);
		}
		const queue =
			delivery === 'retry' ? this.pipelineRetryQueueNames[retryNumber - 1] : this.pipelineQueueName;
		if (
			!queue ||
			!Number.isInteger(retryNumber) ||
			retryNumber < 0 ||
			retryNumber > pipelineRetries
		)
			throw new Error('InvalidPipelineRetry');
		return this.publish(
			delivery === 'retry' ? 'retry' : 'ready',
			queue,
			clean,
			messageId,
			retryNumber,
			true,
		);
	}

	quarantinePipelineMessage(): Promise<void> {
		return this.publish(
			'dead',
			this.pipelineDeadQueueName,
			{ errorCode: 'INVALID_MESSAGE' },
			randomUUID(),
			0,
			true,
		);
	}

	async createConsumerChannel(pipeline = false): Promise<Channel> {
		const publisher = await this.getPublisher();
		if (pipeline) await this.ensurePipelineTopology(publisher);
		const connection = this.connection;
		const abort = this.connectionAbort;
		if (!connection || !abort) throw new Error('RabbitMQUnavailable');
		return this.withTimeout(connection.createChannel(), abort);
	}

	// Passive inspections use their own channel. A failed inspection must never close a
	// publisher or consumer channel, or cause an otherwise idle API to open a connection.
	async readyDepths(): Promise<{ ready: number; dead: number } | undefined> {
		if (this.closing || !this.connection) return;
		const channel = await this.connection.createChannel();
		channel.on('error', () => {});
		try {
			const ready = await channel.checkQueue(this.queueName);
			const dead = await channel.checkQueue(this.deadQueueName);
			return { ready: ready.messageCount, dead: dead.messageCount };
		} finally {
			await channel.close().catch(() => {});
		}
	}

	async onModuleDestroy(): Promise<void> {
		this.closing = true;
		await this.opening?.catch(() => {});
		await this.publisher?.close().catch(() => {});
		await this.connection?.close().catch(() => {});
		this.publisher = undefined;
		this.connection = undefined;
		this.connectionAbort = undefined;
	}

	private publish(
		destination: Destination,
		queue: string,
		payload: object,
		messageId: string,
		attemptsMade: number,
		pipeline = false,
	): Promise<void> {
		return withSpan(
			'rabbitmq.publish',
			async () => {
				await this.sendConfirmed(queue, payload, messageId, attemptsMade, pipeline);
				(pipeline ? pipelinePublications : publications).add(1, { destination });
				logEvent('info', 'rabbitmq.publish', { result: destination });
			},
			{
				kind: SpanKind.PRODUCER,
				attributes: {
					'messaging.system': 'rabbitmq',
					'messaging.destination.name': queue,
					destination,
				},
			},
		);
	}

	private async sendConfirmed(
		queue: string,
		payload: object,
		messageId: string,
		attemptsMade: number,
		pipeline: boolean,
	): Promise<void> {
		const channel = await this.getPublisher();
		if (pipeline) await this.ensurePipelineTopology(channel);
		const connectionAbort = this.connectionAbort;
		const correlationId = randomUUID();
		const publication = { returned: false };
		this.publications.set(correlationId, publication);
		const options: Options.Publish = {
			persistent: true,
			mandatory: true,
			contentType: 'application/json',
			messageId,
			correlationId,
			headers: {
				...messageHeaders(),
				[pipeline ? 'x-pipeline-retry' : 'x-export-attempts']: attemptsMade,
				[pipeline ? 'x-pipeline-sent-ms' : 'x-export-sent-ms']: Date.now(),
			},
		};
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				channel.off('close', onClose);
				this.publications.delete(correlationId);
				if (error) reject(error);
				else resolve();
			};
			const onClose = () => finish(new Error('RabbitMQPublishFailed'));
			const timeout = setTimeout(() => {
				finish(new Error('RabbitMQConfirmTimeout'));
				void channel.close().catch(() => {});
				connectionAbort?.abort();
			}, this.timeoutMs);
			channel.once('close', onClose);
			try {
				channel.sendToQueue(queue, Buffer.from(JSON.stringify(payload)), options, (error) => {
					if (error) finish(new Error('RabbitMQPublishFailed'));
					else if (publication.returned) finish(new Error('RabbitMQUnroutable'));
					else finish();
				});
			} catch {
				finish(new Error('RabbitMQPublishFailed'));
			}
		});
	}

	private getPublisher(): Promise<ConfirmChannel> {
		if (this.closing) return Promise.reject(new Error('RabbitMQClosing'));
		if (this.publisher) return Promise.resolve(this.publisher);
		if (this.opening) return this.opening;
		this.opening = this.open().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	private async open(): Promise<ConfirmChannel> {
		const abort = new AbortController();
		let connection: ChannelModel | undefined;
		try {
			const socketOptions = { timeout: this.timeoutMs, signal: abort.signal };
			connection = await this.withTimeout(connect(this.url, socketOptions), abort);
			connection.on('error', () => this.logger.warn('RabbitMQ connection error'));
			const ownedConnection = connection;
			connection.on('close', () => {
				abort.abort();
				if (this.connection === ownedConnection) {
					this.publisher = undefined;
					this.connection = undefined;
					this.connectionAbort = undefined;
				}
			});
			const channel = await this.withTimeout(connection.createConfirmChannel(), abort);
			channel.on('error', () => this.logger.warn('RabbitMQ publisher channel error'));
			channel.on('close', () => {
				abort.abort();
				if (this.publisher === channel) {
					this.publisher = undefined;
					this.connection = undefined;
					this.connectionAbort = undefined;
				}
			});
			channel.on('return', (message) => {
				const publication = this.publications.get(message.properties.correlationId);
				if (publication) publication.returned = true;
			});
			await this.withTimeout(this.assertTopology(channel), abort);
			if (abort.signal.aborted || this.closing) throw new Error('RabbitMQClosing');
			this.connection = connection;
			this.connectionAbort = abort;
			this.publisher = channel;
			return channel;
		} catch {
			abort.abort();
			void connection?.close().catch(() => {});
			throw new Error('RabbitMQUnavailable');
		}
	}

	private ensurePipelineTopology(channel: ConfirmChannel): Promise<void> {
		if (this.pipelineTopology?.channel === channel) return this.pipelineTopology.ready;
		const abort = this.connectionAbort;
		if (!abort) throw new Error('RabbitMQUnavailable');
		const ready = this.withTimeout(this.assertTopology(channel, true), abort).catch((error) => {
			if (this.pipelineTopology?.channel === channel) this.pipelineTopology = undefined;
			throw error;
		});
		this.pipelineTopology = { channel, ready };
		return ready;
	}

	private async assertTopology(channel: ConfirmChannel, pipeline = false): Promise<void> {
		const ready = pipeline ? this.pipelineQueueName : this.queueName;
		const dead = pipeline ? this.pipelineDeadQueueName : this.deadQueueName;
		const retries = pipeline ? this.pipelineRetryQueueNames : this.retryQueueNames;
		const baseDelay = pipeline ? this.pipelineBackoffMs : this.backoffMs;
		const quorum = {
			durable: true,
			arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': -1 },
		};
		await channel.assertQueue(ready, quorum);
		await channel.assertQueue(dead, quorum);
		const delayed = (ttl: number) => ({
			durable: true,
			arguments: {
				...quorum.arguments,
				'x-message-ttl': ttl,
				'x-dead-letter-exchange': '',
				'x-dead-letter-routing-key': ready,
				'x-dead-letter-strategy': 'at-least-once',
				'x-overflow': 'reject-publish',
			},
		});
		for (const [index, name] of retries.entries()) {
			await channel.assertQueue(name, delayed(baseDelay * 2 ** index));
		}
		if (!pipeline) await channel.assertQueue(this.leaseQueueName, delayed(this.leaseDelayMs));
	}

	private async withTimeout<T>(operation: Promise<T>, abort: AbortController): Promise<T> {
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				operation,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						reject(new Error('RabbitMQOperationTimeout'));
						abort.abort();
					}, this.timeoutMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private positiveInteger(config: ConfigService, name: string, fallback: number): number {
		const value = Number(config.get<string>(name) ?? fallback);
		if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive`);
		return value;
	}
}
