import { randomUUID } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ExportJob, ExportJobStatus, OutboxEventType, WorkspaceRole } from '@prisma/client';
import { AccessPolicyService } from '../access/access-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import {
	OBJECT_STORAGE,
	ObjectStorageService,
	STORAGE_CONFIG,
	StorageConfig,
} from '../storage/storage.tokens';

@Injectable()
export class ExportsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly accessPolicy: AccessPolicyService,
		@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorageService,
		@Inject(STORAGE_CONFIG) private readonly storageConfig: StorageConfig,
	) {}

	async create(userId: string, workspaceId: string) {
		await this.accessPolicy.requireWorkspace(userId, workspaceId, 'view', 'document');
		const id = randomUUID();
		const queueJobId = `export-${id}`;
		const filters = { schemaVersion: 1 } as const;
		const job = await this.prisma.$transaction(async (tx) => {
			const created = await tx.exportJob.create({
				data: { id, workspaceId, requestedById: userId, queueJobId, filters },
			});
			await tx.outboxEvent.create({
				data: {
					type: OutboxEventType.EXPORT_REQUESTED,
					aggregateId: id,
					payload: { exportJobId: id, schemaVersion: 1 },
				},
			});
			return created;
		});
		return {
			id: job.id,
			status: job.status,
			progress: job.progress,
			createdAt: job.createdAt,
		};
	}

	async get(userId: string, exportId: string) {
		const job = await this.requireAccessibleJob(userId, exportId);
		return this.publicJob(job, true);
	}

	async cancel(userId: string, exportId: string) {
		const job = await this.requireAccessibleJob(userId, exportId);
		const now = new Date();
		while (true) {
			await this.prisma.exportJob.updateMany({
				where: { id: job.id, status: ExportJobStatus.QUEUED, objectKey: null },
				data: {
					status: ExportJobStatus.CANCELLED,
					cancelRequestedAt: now,
					finishedAt: now,
				},
			});
			await this.prisma.exportJob.updateMany({
				where: {
					id: job.id,
					status: { in: [ExportJobStatus.QUEUED, ExportJobStatus.PROCESSING] },
					cancelRequestedAt: null,
				},
				data: { cancelRequestedAt: now },
			});
			const current = await this.prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
			if (
				current.cancelRequestedAt ||
				(current.status !== ExportJobStatus.QUEUED && current.status !== ExportJobStatus.PROCESSING)
			) {
				return this.publicJob(current, true);
			}
		}
	}

	private async requireAccessibleJob(userId: string, exportId: string): Promise<ExportJob> {
		const job = await this.prisma.exportJob.findUnique({ where: { id: exportId } });
		if (!job) throw new NotFoundException();
		const membership = await this.prisma.workspaceMember.findUnique({
			where: { userId_workspaceId: { userId, workspaceId: job.workspaceId } },
		});
		if (!membership) throw new NotFoundException();
		if (job.requestedById !== userId && membership.role !== WorkspaceRole.OWNER) {
			throw new ForbiddenException();
		}
		return job;
	}

	private async publicJob(job: ExportJob, includeDownload: boolean) {
		let downloadUrl: string | null = null;
		let downloadExpiresInSeconds: number | null = null;
		if (
			includeDownload &&
			job.status === ExportJobStatus.COMPLETED &&
			job.objectKey &&
			job.expiresAt &&
			job.expiresAt.getTime() > Date.now()
		) {
			downloadUrl = await this.storage.createDownloadUrl({
				objectKey: job.objectKey,
				downloadName: 'documents.csv',
				expiresInSeconds: this.storageConfig.downloadTtlSeconds,
			});
			downloadExpiresInSeconds = this.storageConfig.downloadTtlSeconds;
		}
		return {
			id: job.id,
			workspaceId: job.workspaceId,
			status: job.status,
			progress: job.progress,
			attempts: job.attempts,
			errorCode: job.errorCode,
			createdAt: job.createdAt,
			startedAt: job.startedAt,
			finishedAt: job.finishedAt,
			expiresAt: job.expiresAt,
			expiredAt: job.expiredAt,
			cancelRequestedAt: job.cancelRequestedAt,
			downloadUrl,
			downloadExpiresInSeconds,
		};
	}
}
