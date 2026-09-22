import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExportJobStatus } from '@prisma/client';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { ExportMaintenanceService } from './exports/export-maintenance.service';
import { ExportProcessorService } from './exports/export-processor.service';
import { PrismaService } from './prisma/prisma.service';
import { ExportQueuePayload } from './queue/queue.constants';
import { QueueService } from './queue/queue.service';

@Injectable()
export class WorkerRuntimeService {
	private readonly logger = new Logger(WorkerRuntimeService.name);
	private readonly redisUrl: string;
	private readonly queueName: string;
	private readonly pendingDeadLetters = new Set<Promise<void>>();
	private connection?: Redis;
	private worker?: Worker<ExportQueuePayload>;

	constructor(
		config: ConfigService,
		private readonly processor: ExportProcessorService,
		private readonly maintenance: ExportMaintenanceService,
		private readonly prisma: PrismaService,
		private readonly queues: QueueService,
	) {
		this.redisUrl = config.get<string>('REDIS_URL') ?? '';
		if (!this.redisUrl) throw new Error('REDIS_URL is required for BullMQ worker');
		this.queueName = config.get<string>('EXPORT_QUEUE_NAME') ?? 'workspace-exports';
	}

	start(): void {
		if (this.worker) return;
		this.connection = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
		this.worker = new Worker<ExportQueuePayload>(
			this.queueName,
			(job) => this.processor.process(job),
			{ connection: this.connection, concurrency: 2 },
		);
		this.worker.on('error', (error) => {
			this.logger.error(`BullMQ worker error: ${error.name}`);
		});
		this.worker.on('failed', (job) => {
			if (job) {
				const pending = this.publishDeadLetter(
					job.id ?? job.data.exportJobId,
					job.data.exportJobId,
					job.attemptsMade,
				);
				this.pendingDeadLetters.add(pending);
				void pending.finally(() => this.pendingDeadLetters.delete(pending));
			}
		});
		this.maintenance.start();
	}

	async close(force = false): Promise<void> {
		this.maintenance.stop();
		const worker = this.worker;
		if (worker) await worker.close(force);
		await Promise.allSettled([...this.pendingDeadLetters]);
		this.worker = undefined;
		if (this.connection) {
			if (this.connection.status === 'ready') await this.connection.quit();
			else this.connection.disconnect();
			this.connection = undefined;
		}
	}

	async forceClose(): Promise<void> {
		this.maintenance.stop();
		if (this.worker) await this.worker.close(true);
		this.worker = undefined;
		this.connection?.disconnect();
		this.connection = undefined;
	}

	private async publishDeadLetter(
		sourceQueueJobId: string,
		exportJobId: string,
		attempts: number,
	): Promise<void> {
		try {
			const job = await this.prisma.exportJob.findUnique({
				where: { id: exportJobId },
				select: { status: true, errorCode: true },
			});
			if (job?.status !== ExportJobStatus.FAILED) return;
			await this.queues.addDeadLetter(
				createDeadLetterPayload(exportJobId, sourceQueueJobId, attempts, job.errorCode),
			);
		} catch (error) {
			const name = error instanceof Error ? error.name : 'UnknownError';
			this.logger.error(`DLQ publish failed: ${name}`);
		}
	}
}

export function createDeadLetterPayload(
	exportJobId: string,
	sourceQueueJobId: string,
	attempts: number,
	errorCode: string | null,
) {
	return {
		exportJobId,
		sourceQueueJobId,
		attempts,
		errorCode: errorCode ?? 'INTERNAL_ERROR',
	};
}
