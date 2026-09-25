import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import {
	ExportDeadLetterPayload,
	ExportQueuePayload,
	exportQueueAttempts,
	exportQueueBackoffMs,
} from './queue.constants';

@Injectable()
export class QueueService implements OnModuleDestroy {
	private readonly connection: Redis;
	private readonly exportQueue: Queue<ExportQueuePayload>;
	private readonly deadQueue: Queue<ExportDeadLetterPayload>;

	constructor(config: ConfigService) {
		const redisUrl = config.get<string>('REDIS_URL');
		if (!redisUrl) throw new Error('REDIS_URL is required for BullMQ');
		this.connection = new Redis(redisUrl, {
			maxRetriesPerRequest: 1,
			enableReadyCheck: true,
		});
		this.exportQueue = new Queue<ExportQueuePayload>(
			config.get<string>('EXPORT_QUEUE_NAME') ?? 'workspace-exports',
			{ connection: this.connection },
		);
		this.deadQueue = new Queue<ExportDeadLetterPayload>(
			config.get<string>('EXPORT_DLQ_NAME') ?? 'workspace-exports-dead',
			{ connection: this.connection },
		);
	}

	addExport(payload: ExportQueuePayload, queueJobId: string) {
		return this.exportQueue.add('build-export', payload, {
			jobId: queueJobId,
			attempts: exportQueueAttempts,
			backoff: { type: 'exponential', delay: exportQueueBackoffMs },
		});
	}

	addDeadLetter(payload: ExportDeadLetterPayload) {
		return this.deadQueue.add('build-export-dead', payload, {
			jobId: `dead-${payload.sourceQueueJobId}`,
		});
	}

	getFailed(start: number, end: number) {
		return this.exportQueue.getFailed(start, end);
	}

	async onModuleDestroy(): Promise<void> {
		await Promise.allSettled([this.exportQueue.close(), this.deadQueue.close()]);
		if (this.connection.status === 'ready') {
			await this.connection.quit();
		} else {
			this.connection.disconnect();
		}
	}
}
