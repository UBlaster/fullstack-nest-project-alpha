import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExportJobStatus } from '@prisma/client';
import { Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { ExportMaintenanceService } from './export-maintenance.service';
import { ExportProcessorService } from './export-processor.service';
import { PrismaService } from '../prisma/prisma.service';
import { ExportQueuePayload } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class WorkerRuntimeService {
	private readonly logger = new Logger(WorkerRuntimeService.name);
	private readonly redisUrl: string;
	private readonly queueName: string;
	private readonly pendingDeadLetters = new Set<Promise<void>>();
	private connection?: Redis;
	private worker?: Worker<ExportQueuePayload>;
	private reconciliationTimer?: NodeJS.Timeout;
	private reconciliation?: Promise<void>;
	private failedCursor = 0;

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
				const pending = this.publishDeadLetter(job);
				this.pendingDeadLetters.add(pending);
				void pending.finally(() => this.pendingDeadLetters.delete(pending));
			}
		});
		this.maintenance.start();
		this.reconciliationTimer = setInterval(() => void this.reconcileFailed(), 30_000);
		this.reconciliationTimer.unref();
		void this.reconcileFailed();
	}

	// Retained failed queue jobs provide durable retry evidence if the process
	// dies between broker failure, the DB transition and DLQ publication.
	reconcileFailed(): Promise<void> {
		if (this.reconciliation) return this.reconciliation;
		this.reconciliation = (async () => {
			try {
				const jobs = await this.queues.getFailed(this.failedCursor, this.failedCursor + 99);
				for (const job of jobs) await this.publishDeadLetter(job);
				this.failedCursor = jobs.length < 100 ? 0 : this.failedCursor + jobs.length;
			} catch (error) {
				this.logger.warn(
					`Failed-job reconciliation failed: ${error instanceof Error ? error.name : 'UnknownError'}`,
				);
			}
		})().finally(() => {
			this.reconciliation = undefined;
		});
		return this.reconciliation;
	}

	async close(force = false): Promise<void> {
		if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
		this.reconciliationTimer = undefined;
		const worker = this.worker;
		await Promise.all([worker?.close(force), this.maintenance.stop()]);
		await Promise.allSettled([...this.pendingDeadLetters]);
		await this.reconciliation;
		this.worker = undefined;
		if (this.connection) {
			if (this.connection.status === 'ready') await this.connection.quit();
			else this.connection.disconnect();
			this.connection = undefined;
		}
	}

	private async publishDeadLetter(queueJob: Job<ExportQueuePayload>): Promise<void> {
		try {
			if ((await queueJob.getState()) !== 'failed') return;
			const exportJobId = queueJob.data.exportJobId;
			const sourceQueueJobId = queueJob.id ?? exportJobId;
			await this.prisma.exportJob.updateMany({
				where: { id: exportJobId, queueJobId: sourceQueueJobId, status: ExportJobStatus.QUEUED },
				data: {
					status: ExportJobStatus.FAILED,
					errorCode: 'RETRIES_EXHAUSTED',
					finishedAt: new Date(),
				},
			});
			const job = await this.prisma.exportJob.findUnique({
				where: { id: exportJobId },
				select: { status: true, errorCode: true },
			});
			if (job?.status !== ExportJobStatus.FAILED) return;
			await this.queues.addDeadLetter(
				createDeadLetterPayload(
					exportJobId,
					sourceQueueJobId,
					queueJob.attemptsMade,
					job.errorCode,
				),
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
