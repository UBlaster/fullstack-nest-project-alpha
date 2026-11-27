import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PipelineStageRun, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OBJECT_STORAGE, ObjectStorageService } from '../storage/storage.tokens';
import { chunkText, extractText, normalizeText } from './source-text';
import { LeaseLostError } from './pipeline-state';

export async function fence(tx: Prisma.TransactionClient, run: PipelineStageRun) {
	const owned = await tx.pipelineStageRun.updateMany({
		where: { id: run.id, status: 'RUNNING', claimToken: run.claimToken },
		data: { heartbeatAt: new Date() },
	});
	if (!owned.count) throw new LeaseLostError();
}

@Injectable()
export class PipelineContentService {
	constructor(
		private readonly prisma: PrismaService,
		@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorageService,
	) {}

	private async *readParts(versionId: string, stage: 'EXTRACT' | 'NORMALIZE') {
		let offset = -1;
		while (true) {
			const parts = await this.prisma.documentTextPart.findMany({
				where: { versionId, stage, partIndex: { gt: offset } },
				select: { text: true, partIndex: true },
				orderBy: { partIndex: 'asc' },
				take: 16,
			});
			if (!parts.length) return;
			for (const part of parts) yield part.text;
			offset = parts[parts.length - 1].partIndex;
		}
	}

	async write(run: PipelineStageRun, signal: AbortSignal) {
		const { versionId, stage } = run;
		// Only the lease owner may replace an incomplete checkpoint. The downstream
		// stage cannot read it before completion + its outbox event commit together.
		await this.prisma.$transaction(async (tx) => {
			await fence(tx, run);
			if (stage === 'CHUNK') await tx.documentChunk.deleteMany({ where: { versionId } });
			else await tx.documentTextPart.deleteMany({ where: { versionId, stage } });
		});
		if (stage === 'CHUNK') {
			const rows: Prisma.DocumentChunkCreateManyInput[] = [];
			let chunkIndex = 0;
			const flush = () =>
				this.prisma.$transaction(async (tx) => {
					await fence(tx, run);
					await tx.documentChunk.createMany({ data: rows.splice(0) });
				});
			for await (const chunk of chunkText(this.readParts(versionId, 'NORMALIZE'))) {
				signal.throwIfAborted();
				rows.push({
					versionId,
					chunkIndex: chunkIndex++,
					...chunk,
					textHash: createHash('sha256').update(chunk.text).digest('hex'),
				});
				if (rows.length === 64) await flush();
			}
			if (rows.length) await flush();
			return;
		}

		const parts =
			stage === 'EXTRACT'
				? await this.extract(run, signal)
				: normalizeText(this.readParts(versionId, 'EXTRACT'));
		let partIndex = 0;
		const rows: Prisma.DocumentTextPartCreateManyInput[] = [];
		const flush = () =>
			this.prisma.$transaction(async (tx) => {
				await fence(tx, run);
				await tx.documentTextPart.createMany({ data: rows.splice(0) });
			});
		for await (const text of parts) {
			signal.throwIfAborted();
			rows.push({ versionId, stage, partIndex: partIndex++, text });
			if (rows.length === 16) await flush();
		}
		if (rows.length) await flush();
	}

	private async extract(run: PipelineStageRun, signal: AbortSignal) {
		const { sourceFile } = await this.prisma.documentVersion.findUniqueOrThrow({
			where: { id: run.versionId },
			select: { sourceFile: { select: { objectKey: true, mimeType: true, size: true } } },
		});
		const stream = await this.storage.readStream(sourceFile.objectKey, signal);
		return extractText(stream, sourceFile.size, run.inputHash, sourceFile.mimeType, signal);
	}
}
