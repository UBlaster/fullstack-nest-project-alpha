import { randomUUID } from 'node:crypto';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PipelineStageRun, Prisma } from '@prisma/client';
import { AccessPolicyService } from '../access/access-policy.service';
import { EmbeddingValidationError } from '../embeddings/embeddings.errors';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { withMessageContext } from '../observability/carrier';
import { logEvent } from '../observability/logger';
import { meter, withSpan } from '../observability/telemetry';
import { PrismaService } from '../prisma/prisma.service';
import type { PipelineJob } from '../queue/queue.constants';
import { fence, PipelineContentService } from './pipeline-content.service';
import {
	dispatchStage,
	enqueueFirstDelivery,
	InvalidSourceError,
	LeaseLostError,
	STAGES,
	STAGE_STATUS,
} from './pipeline-state';

type Result = {
	result: 'completed' | 'duplicate' | 'out_of_order' | 'retry' | 'dead';
	aggregateId?: string;
};
const recoveries = meter.createCounter('pipeline.stage.recoveries');

@Injectable()
export class PipelineProcessorService {
	private readonly leaseMs: number;
	constructor(
		private readonly prisma: PrismaService,
		private readonly content: PipelineContentService,
		private readonly access: AccessPolicyService,
		private readonly embeddings: EmbeddingsService,
		config: ConfigService,
	) {
		this.leaseMs = Number(config.get('PIPELINE_LEASE_MS') ?? 60_000);
		if (!Number.isInteger(this.leaseMs) || this.leaseMs < 100)
			throw new Error('Invalid PIPELINE_LEASE_MS');
	}

	async process(job: PipelineJob, retryNumber = 0): Promise<Result> {
		const claim = await this.claim(job, retryNumber);
		return 'result' in claim ? claim : this.execute(claim);
	}

	private async claim(job: PipelineJob, retryNumber: number): Promise<PipelineStageRun | Result> {
		const versionId = job.documentVersionId;
		const { stage, inputHash } = job;
		return this.prisma.$transaction(async (tx) => {
			// Serialize claim, retry, and recovery decisions for this stage.
			const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "PipelineStageRun"
				WHERE "versionId"=${versionId} AND stage=${stage}::"PipelineStage" AND "inputHash"=${inputHash} FOR UPDATE`;
			if (!locked.length) return { result: 'out_of_order' };
			const run = await tx.pipelineStageRun.findUniqueOrThrow({ where: { id: locked[0].id } });
			if (run.status !== 'PENDING' || run.attempts !== retryNumber) {
				// If DB committed a failure but confirm/ACK was interrupted, redelivery
				// must confirm the same durable retry/DLQ dispatch before ACK.
				if (run.status === 'FAILED' || (run.status === 'PENDING' && run.attempts > retryNumber)) {
					const aggregateId = run.id + ':' + run.dispatch;
					const pending = await tx.outboxEvent.findUnique({
						where: { type_aggregateId: { type: 'PIPELINE_STAGE', aggregateId } },
						select: { publishedAt: true },
					});
					if (pending && !pending.publishedAt)
						return { result: run.status === 'FAILED' ? 'dead' : 'retry', aggregateId };
				}
				return { result: 'duplicate' };
			}
			const previous = STAGES[STAGES.indexOf(stage) - 1];
			if (
				previous &&
				!(await tx.pipelineStageRun.count({
					where: { versionId, stage: previous, status: 'COMPLETED', inputHash },
				}))
			) {
				return { result: 'out_of_order' };
			}
			await tx.documentVersion.update({
				where: { id: versionId },
				data: { status: STAGE_STATUS[stage] },
			});
			return tx.pipelineStageRun.update({
				where: { id: run.id },
				data: {
					status: 'RUNNING',
					attempts: { increment: 1 },
					claimToken: randomUUID(),
					errorCode: null,
					heartbeatAt: new Date(),
				},
			});
		});
	}

	private async execute(run: PipelineStageRun): Promise<Result> {
		const abort = new AbortController();
		let pulse: Promise<void> | undefined;
		const timer = setInterval(
			() => {
				if (pulse) return;
				pulse = this.prisma.pipelineStageRun
					.updateMany({
						where: { id: run.id, status: 'RUNNING', claimToken: run.claimToken },
						data: { heartbeatAt: new Date() },
					})
					.then(({ count }) => {
						if (!count) abort.abort(new LeaseLostError());
					})
					.catch((error: unknown) => abort.abort(error))
					.finally(() => {
						pulse = undefined;
					});
			},
			Math.max(25, Math.floor(this.leaseMs / 3)),
		);
		timer.unref();
		try {
			const version = await this.prisma.documentVersion.findUniqueOrThrow({
				where: { id: run.versionId },
				select: { documentId: true, requestedById: true, version: true },
			});
			await this.access.requireDocument(version.requestedById, version.documentId, 'update');
			if (run.stage === 'EXTRACT' || run.stage === 'NORMALIZE' || run.stage === 'CHUNK') {
				await this.content.write(run, abort.signal);
			} else {
				// A model rollout may have started after EMBED completed. Repair only
				// missing vectors, then recheck coverage under the rollout lock.
				await this.embeddings.embedVersion(run.versionId, abort.signal, (tx) => fence(tx, run));
			}
			abort.signal.throwIfAborted();
			await this.prisma.$transaction(async (tx) => {
				await fence(tx, run);
				if (run.stage === 'INDEX' || run.stage === 'ACTIVATE')
					await this.embeddings.assertVersionComplete(run.versionId, tx);
				if (run.stage === 'INDEX') {
					await tx.documentVersion.update({
						where: { id: run.versionId },
						data: { status: 'INDEXED' },
					});
				}
				if (run.stage === 'ACTIVATE') {
					// Monotonic even when an older slow version finishes after a newer one.
					await tx.$queryRaw`SELECT id FROM "Document" WHERE id=${version.documentId} FOR UPDATE`;
					await tx.document.updateMany({
						where: {
							id: version.documentId,
							OR: [
								{ currentVersionId: null },
								{ currentVersion: { version: { lt: version.version } } },
							],
						},
						data: { currentVersionId: run.versionId },
					});
				}
				if (run.stage === 'CHUNK')
					await tx.documentTextPart.deleteMany({ where: { versionId: run.versionId } });
				await tx.pipelineStageRun.update({
					where: { id: run.id },
					data: { status: 'COMPLETED', completedAt: new Date(), claimToken: null },
				});
				const next = STAGES[STAGES.indexOf(run.stage) + 1];
				if (next) await enqueueFirstDelivery(tx, run.versionId, next, run.inputHash);
			});
			return { result: 'completed' };
		} catch (error) {
			if (abort.signal.aborted) throw abort.signal.reason;
			// An uncertain DB operation or ownership loss leaves delivery and recovery
			// to the broker/lease. Never turn it into a provider failure.
			if (
				error instanceof LeaseLostError ||
				error instanceof Prisma.PrismaClientKnownRequestError ||
				error instanceof Prisma.PrismaClientUnknownRequestError ||
				error instanceof Prisma.PrismaClientInitializationError ||
				error instanceof Prisma.PrismaClientRustPanicError
			)
				throw error;
			let code: string | undefined;
			if (error instanceof ForbiddenException || error instanceof NotFoundException)
				code = 'MEMBERSHIP_REVOKED';
			if (error instanceof InvalidSourceError) code = 'INVALID_SOURCE';
			if (error instanceof EmbeddingValidationError) code = 'INVALID_EMBEDDING';
			return this.prisma.$transaction(async (tx) => {
				await fence(tx, run);
				return this.recordFailure(tx, run, code);
			});
		} finally {
			clearInterval(timer);
			await pulse;
		}
	}

	private async recordFailure(
		tx: Prisma.TransactionClient,
		run: PipelineStageRun,
		permanentCode?: string,
	): Promise<Result> {
		const code = permanentCode ?? (run.attempts >= 6 ? 'RETRIES_EXHAUSTED' : undefined);
		const next = await tx.pipelineStageRun.update({
			where: { id: run.id },
			data: {
				status: code ? 'FAILED' : 'PENDING',
				errorCode: code ?? 'TEMPORARY_FAILURE',
				claimToken: null,
				heartbeatAt: null,
			},
		});
		if (code)
			await tx.documentVersion.update({ where: { id: run.versionId }, data: { status: 'FAILED' } });
		const result = code ? 'dead' : 'retry';
		const aggregateId = await dispatchStage(tx, next, result);
		return { result, aggregateId };
	}

	async recover(now = new Date()) {
		const cutoff = new Date(now.getTime() - this.leaseMs);
		const stale = await this.prisma.pipelineStageRun.findMany({
			where: { status: 'RUNNING', heartbeatAt: { lt: cutoff } },
			orderBy: { heartbeatAt: 'asc' },
			take: 50,
		});
		let recovered = 0;
		for (const run of stale) {
			const last = await this.prisma.outboxEvent.findUnique({
				where: {
					type_aggregateId: { type: 'PIPELINE_STAGE', aggregateId: run.id + ':' + run.dispatch },
				},
				select: { payload: true },
			});
			const payload = last?.payload;
			const carrier =
				payload && typeof payload === 'object' && !Array.isArray(payload)
					? payload.carrier
					: undefined;
			const changed = await withMessageContext(carrier, () =>
				withSpan('pipeline.recover', async (span) => {
					const changed = await this.prisma.$transaction(async (tx) => {
						const owned = await tx.pipelineStageRun.updateMany({
							where: {
								id: run.id,
								status: 'RUNNING',
								claimToken: run.claimToken,
								heartbeatAt: { lt: cutoff },
							},
							data: { claimToken: null },
						});
						if (!owned.count) return false;
						await this.recordFailure(tx, run);
						return true;
					});
					if (changed) {
						span.setAttribute('pipeline.stage', run.stage);
						logEvent('info', 'pipeline.recover', {
							stage: run.stage,
							documentVersionId: run.versionId,
							result: 'recovered',
						});
						recoveries.add(1, { stage: run.stage });
					}
					return changed;
				}),
			);
			if (changed) recovered++;
		}
		return recovered;
	}
}
