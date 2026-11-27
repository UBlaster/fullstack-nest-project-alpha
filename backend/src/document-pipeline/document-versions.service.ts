import { createHash } from 'node:crypto';
import {
	ConflictException,
	Inject,
	Injectable,
	NotFoundException,
	UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessPolicyService } from '../access/access-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { OBJECT_STORAGE, ObjectStorageService } from '../storage/storage.tokens';
import {
	dispatchStage,
	enqueueFirstDelivery,
	InvalidSourceError,
	PIPELINE_VERSION,
	STAGES,
	STAGE_STATUS,
} from './pipeline-state';
import { sourceBytes } from './source-text';

const versionSelect = {
	id: true,
	documentId: true,
	sourceFileId: true,
	version: true,
	status: true,
	pipelineVersion: true,
	createdAt: true,
	updatedAt: true,
	document: { select: { currentVersionId: true } },
	stages: {
		select: {
			stage: true,
			status: true,
			attempts: true,
			errorCode: true,
			heartbeatAt: true,
			completedAt: true,
		},
	},
} satisfies Prisma.DocumentVersionSelect;

function present({
	document,
	stages,
	...version
}: Prisma.DocumentVersionGetPayload<{ select: typeof versionSelect }>) {
	return {
		...version,
		isCurrent: document.currentVersionId === version.id,
		stages: stages.sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage)),
	};
}

@Injectable()
export class DocumentVersionsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly access: AccessPolicyService,
		@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorageService,
	) {}

	async create(userId: string, documentId: string, sourceFileId: string) {
		await this.access.requireDocument(userId, documentId, 'update');
		const file = await this.prisma.documentFile.findFirst({
			where: { id: sourceFileId, documentId },
		});
		if (!file) throw new NotFoundException();
		if (file.status !== 'READY') throw new ConflictException('Source file must be ready');
		const hash = createHash('sha256');
		try {
			for await (const bytes of sourceBytes(
				await this.storage.readStream(file.objectKey),
				file.size,
			))
				hash.update(bytes);
		} catch (error) {
			if (error instanceof InvalidSourceError)
				throw new UnprocessableEntityException('Invalid source size');
			throw error;
		}
		const contentHash = hash.digest('hex');
		const versionId = await this.prisma.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${documentId} FOR UPDATE`;
			const ready = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "DocumentFile"
				WHERE id=${sourceFileId} AND "documentId"=${documentId} AND status='READY' FOR UPDATE`;
			if (!ready.length) throw new ConflictException('Source file is no longer ready');
			const existing = await tx.documentVersion.findUnique({
				where: { documentId_contentHash: { documentId, contentHash } },
				select: { id: true },
			});
			if (existing) return existing.id;
			const latest = await tx.documentVersion.aggregate({
				where: { documentId },
				_max: { version: true },
			});
			const version = await tx.documentVersion.create({
				data: {
					documentId,
					version: (latest._max.version ?? 0) + 1,
					sourceFileId,
					contentHash,
					requestedById: userId,
					pipelineVersion: PIPELINE_VERSION,
				},
				select: { id: true },
			});
			await enqueueFirstDelivery(tx, version.id, 'EXTRACT', contentHash);
			return version.id;
		});
		return this.get(userId, versionId);
	}

	async list(userId: string, documentId: string) {
		await this.access.requireDocument(userId, documentId, 'view');
		return (
			await this.prisma.documentVersion.findMany({
				where: { documentId },
				select: versionSelect,
				orderBy: { version: 'desc' },
			})
		).map(present);
	}

	async get(userId: string, id: string) {
		const version = await this.prisma.documentVersion.findUnique({
			where: { id },
			select: versionSelect,
		});
		if (!version) throw new NotFoundException();
		await this.access.requireDocument(userId, version.documentId, 'view');
		return present(version);
	}

	async retry(userId: string, id: string) {
		const version = await this.prisma.documentVersion.findUnique({
			where: { id },
			select: { documentId: true },
		});
		if (!version) throw new NotFoundException();
		await this.access.requireDocument(userId, version.documentId, 'update');
		await this.prisma.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "DocumentVersion" WHERE id=${id} FOR UPDATE`;
			const failed = await tx.pipelineStageRun.findFirst({
				where: { versionId: id, status: 'FAILED' },
			});
			if (!failed) throw new ConflictException('No failed stage to retry');
			const run = await tx.pipelineStageRun.update({
				where: { id: failed.id },
				data: {
					status: 'PENDING',
					attempts: 0,
					errorCode: null,
					claimToken: null,
					heartbeatAt: null,
				},
			});
			await tx.documentVersion.update({
				where: { id },
				data: { status: STAGE_STATUS[run.stage], requestedById: userId },
			});
			await dispatchStage(tx, run, 'stage');
		});
		return this.get(userId, id);
	}
}
