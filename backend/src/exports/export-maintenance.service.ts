import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExportJobStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OBJECT_STORAGE, ObjectStorageService } from '../storage/storage.tokens';

@Injectable()
export class ExportMaintenanceService {
	private readonly logger = new Logger(ExportMaintenanceService.name);
	private readonly staleAfterMs: number;
	private recoveryTimer?: NodeJS.Timeout;
	private retentionTimer?: NodeJS.Timeout;

	constructor(
		private readonly prisma: PrismaService,
		@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorageService,
		config: ConfigService,
	) {
		this.staleAfterMs = this.positiveInteger(config, 'EXPORT_STALE_AFTER_MS', 300_000);
	}

	start(): void {
		if (this.recoveryTimer || this.retentionTimer) return;
		this.recoveryTimer = setInterval(() => void this.recoveryTick(), 60_000);
		this.retentionTimer = setInterval(() => void this.retentionTick(), 600_000);
		this.recoveryTimer.unref();
		this.retentionTimer.unref();
		void this.recoveryTick();
		void this.retentionTick();
	}

	stop(): void {
		if (this.recoveryTimer) clearInterval(this.recoveryTimer);
		if (this.retentionTimer) clearInterval(this.retentionTimer);
		this.recoveryTimer = undefined;
		this.retentionTimer = undefined;
	}

	async recoverStale(now = new Date()): Promise<number> {
		const cutoff = new Date(now.getTime() - this.staleAfterMs);
		const jobs = await this.prisma.exportJob.findMany({
			where: {
				status: ExportJobStatus.PROCESSING,
				heartbeatAt: { lt: cutoff },
			},
			orderBy: [{ heartbeatAt: 'asc' }, { id: 'asc' }],
			take: 100,
		});
		let recovered = 0;
		for (const job of jobs) {
			const result = await this.prisma.exportJob.updateMany({
				where: {
					id: job.id,
					status: ExportJobStatus.PROCESSING,
					processingToken: job.processingToken,
					heartbeatAt: job.heartbeatAt,
				},
				data: {
					status: ExportJobStatus.QUEUED,
					processingToken: null,
					heartbeatAt: null,
				},
			});
			recovered += result.count;
		}
		return recovered;
	}

	async removeExpired(now = new Date()): Promise<number> {
		const jobs = await this.prisma.exportJob.findMany({
			where: {
				status: ExportJobStatus.COMPLETED,
				expiresAt: { lte: now },
				expiredAt: null,
				objectKey: { not: null },
			},
			orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
			take: 100,
		});
		let removed = 0;
		for (const job of jobs) {
			if (!job.objectKey) continue;
			await this.storage.remove(job.objectKey);
			const result = await this.prisma.exportJob.updateMany({
				where: {
					id: job.id,
					status: ExportJobStatus.COMPLETED,
					objectKey: job.objectKey,
					expiresAt: job.expiresAt,
					expiredAt: null,
				},
				data: { objectKey: null, expiredAt: now },
			});
			removed += result.count;
		}
		return removed;
	}

	private async recoveryTick(): Promise<void> {
		try {
			await this.recoverStale();
		} catch (error) {
			this.logger.warn(`Export recovery failed: ${this.errorName(error)}`);
		}
	}

	private async retentionTick(): Promise<void> {
		try {
			await this.removeExpired();
		} catch (error) {
			this.logger.warn(`Export retention failed: ${this.errorName(error)}`);
		}
	}

	private errorName(error: unknown): string {
		return error instanceof Error ? error.name : 'UnknownError';
	}

	private positiveInteger(config: ConfigService, name: string, fallback: number): number {
		const value = Number(config.get<string>(name) ?? fallback);
		if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be positive`);
		return value;
	}
}
