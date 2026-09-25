import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExportJob, ExportJobStatus } from '@prisma/client';
import { DelayedError, Job, UnrecoverableError } from 'bullmq';
import {
	DocumentsExportService,
	csvLine,
	exportBatchSize,
} from '../documents/documents-export.service';
import { PrismaService } from '../prisma/prisma.service';
import { ExportQueuePayload, exportQueueAttempts } from '../queue/queue.constants';
import { OBJECT_STORAGE, ObjectStorageService } from '../storage/storage.tokens';
import { CancelledExportError, ExportLeaseLostError, PermanentExportError } from './export-errors';

interface ClaimedExport extends ExportJob {
	processingToken: string;
}

@Injectable()
export class ExportProcessorService {
	private readonly heartbeatThrottleMs: number;
	private readonly retentionMs: number;

	constructor(
		private readonly prisma: PrismaService,
		private readonly documentsExport: DocumentsExportService,
		@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorageService,
		config: ConfigService,
	) {
		this.heartbeatThrottleMs = this.positiveInteger(config, 'EXPORT_HEARTBEAT_THROTTLE_MS', 2_000);
		this.retentionMs = this.positiveInteger(config, 'EXPORT_RETENTION_MS', 86_400_000);
	}

	async process(job: Job<ExportQueuePayload>): Promise<void> {
		if (job.data.schemaVersion !== 1 || typeof job.data.exportJobId !== 'string') {
			throw new UnrecoverableError('INVALID_FILTERS');
		}
		const current = await this.prisma.exportJob.findUnique({
			where: { id: job.data.exportJobId },
		});
		if (!current) throw new UnrecoverableError('INVALID_FILTERS');
		if (this.isTerminal(current.status)) return;
		const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? exportQueueAttempts);

		if (current.cancelRequestedAt && current.status === ExportJobStatus.QUEUED) {
			try {
				await this.cancelQueued(current);
				return;
			} catch (error) {
				await this.recordQueuedCleanupFailure(current, finalAttempt);
				throw error;
			}
		}

		try {
			// Preserve the last attempt's key until cleanup succeeds. In particular,
			// recovery or a failed delete must not lose the only durable reference.
			if (current.status === ExportJobStatus.QUEUED && current.objectKey) {
				await this.storage.remove(current.objectKey);
			}
			this.assertFilters(current.filters);
			await this.assertMembership(current);
		} catch (error) {
			await this.handlePreClaimFailure(job, current, error);
		}

		const claim = await this.claim(current);
		if (!claim) {
			const latest = await this.prisma.exportJob.findUnique({ where: { id: current.id } });
			if (latest && this.isTerminal(latest.status)) return;
			// A stalled BullMQ delivery may arrive before the five-minute DB recovery.
			// Delay without consuming a retry or acknowledging unfinished domain work.
			if (job.token) {
				await job.moveToDelayed(Date.now() + this.heartbeatThrottleMs, job.token);
				throw new DelayedError();
			}
			throw new ExportLeaseLostError();
		}

		try {
			await this.buildAndStore(claim);
		} catch (error) {
			if (error instanceof CancelledExportError) {
				try {
					await this.finishCancelled(claim);
					return;
				} catch (cleanupError) {
					if (cleanupError instanceof ExportLeaseLostError) throw cleanupError;
					await this.finishCleanupFailure(claim, finalAttempt);
					throw cleanupError;
				}
			}
			if (error instanceof ExportLeaseLostError) {
				await this.removeAttemptObject(claim);
				throw error;
			}
			if (error instanceof PermanentExportError) {
				await this.finishFailed(claim, error.code);
				throw new UnrecoverableError(error.code);
			}

			const code = finalAttempt ? 'RETRIES_EXHAUSTED' : this.classifyTransient(error);
			try {
				await this.removeAttemptObject(claim);
			} catch (cleanupError) {
				await this.finishCleanupFailure(claim, finalAttempt);
				throw cleanupError;
			}
			if (finalAttempt) await this.finishFailed(claim, code);
			else await this.releaseForRetry(claim, code);
			throw error instanceof Error ? error : new Error('Unknown export failure');
		}
	}

	async claim(current: ExportJob, now = new Date()): Promise<ClaimedExport | null> {
		const processingToken = randomUUID();
		// Fence S3 writes too: a recovered old worker must not overwrite or delete
		// the winning attempt's file. The exact key remains persisted for cleanup.
		const objectKey = `workspaces/${current.workspaceId}/exports/${current.id}/${processingToken}.csv`;
		const claimed = await this.prisma.exportJob.updateMany({
			where: {
				id: current.id,
				status: ExportJobStatus.QUEUED,
				cancelRequestedAt: null,
				attempts: current.attempts,
			},
			data: {
				status: ExportJobStatus.PROCESSING,
				processingToken,
				objectKey,
				heartbeatAt: now,
				startedAt: current.startedAt ?? now,
				attempts: { increment: 1 },
				errorCode: null,
			},
		});
		if (claimed.count === 0) return null;
		return {
			...current,
			status: ExportJobStatus.PROCESSING,
			processingToken,
			objectKey,
			heartbeatAt: now,
			startedAt: current.startedAt ?? now,
			attempts: current.attempts + 1,
		};
	}

	private async buildAndStore(claim: ClaimedExport): Promise<void> {
		const controller = new AbortController();
		const monitorController = new AbortController();
		const output = new PassThrough({ highWaterMark: 64 * 1024 });
		const objectKey = this.objectKey(claim);
		let total = 0;
		let processed = 0;

		const upload = this.storage.uploadStream({
			objectKey,
			body: output,
			contentType: 'text/csv; charset=utf-8',
			signal: controller.signal,
		});
		let monitorError: unknown;
		const produce = async () => {
			total = await this.prisma.document.count({
				where: { project: { workspaceId: claim.workspaceId } },
			});
			await this.writeChunk(
				output,
				'\uFEFFid,projectId,title,status,authorName,updatedAt\r\n',
				controller.signal,
			);
			const iterator = this.documentsExport
				.iterateForExport(claim.workspaceId, controller.signal)
				[Symbol.asyncIterator]();
			while (true) {
				if (processed % exportBatchSize === 0) {
					await this.assertActive(claim);
				}
				const next = await iterator.next();
				if (next.done) break;
				const row = next.value;
				await this.writeChunk(
					output,
					csvLine([row.id, row.projectId, row.title, row.status, row.author.name, row.updatedAt]),
					controller.signal,
				);
				processed += 1;
			}
			output.end();
		};
		const producer = produce();
		const pipeline = Promise.all([producer, upload]);
		const monitor = this.monitorActive(
			claim,
			() => processed,
			() => total,
			controller,
			output,
			monitorController.signal,
			(error) => {
				monitorError = error;
			},
		);

		try {
			await Promise.race([pipeline, monitor]);
			await pipeline;
		} catch (error) {
			controller.abort();
			output.destroy();
			// Promise.all rejects at the first failure; its rejection does not mean
			// the sibling upload has stopped writing. Settle both before cleanup.
			await Promise.allSettled([producer, upload]);
			throw monitorError ?? error;
		} finally {
			monitorController.abort();
			await Promise.allSettled([monitor]);
		}

		const finishedAt = new Date();
		const completed = await this.prisma.exportJob.updateMany({
			where: {
				id: claim.id,
				status: ExportJobStatus.PROCESSING,
				processingToken: claim.processingToken,
				cancelRequestedAt: null,
			},
			data: {
				status: ExportJobStatus.COMPLETED,
				progress: 100,
				objectKey,
				finishedAt,
				expiresAt: new Date(finishedAt.getTime() + this.retentionMs),
				heartbeatAt: null,
				processingToken: null,
			},
		});
		if (completed.count === 0) {
			const state = await this.prisma.exportJob.findUnique({ where: { id: claim.id } });
			if (state?.cancelRequestedAt && state.processingToken === claim.processingToken) {
				await this.storage.remove(objectKey);
				throw new CancelledExportError();
			}
			throw new ExportLeaseLostError();
		}
	}

	private async monitorActive(
		claim: ClaimedExport,
		processed: () => number,
		total: () => number,
		uploadController: AbortController,
		output: PassThrough,
		signal: AbortSignal,
		onFailure: (error: unknown) => void,
	): Promise<void> {
		while (true) {
			try {
				await delay(this.heartbeatThrottleMs, undefined, { signal, ref: false });
			} catch (error) {
				if (signal.aborted) return;
				throw error;
			}
			try {
				await this.heartbeat(claim, processed(), total(), new Date());
			} catch (error) {
				onFailure(error);
				uploadController.abort();
				output.destroy();
				throw error;
			}
		}
	}

	private async assertActive(claim: ClaimedExport): Promise<void> {
		const current = await this.prisma.exportJob.findUnique({
			where: { id: claim.id },
			select: { status: true, processingToken: true, cancelRequestedAt: true },
		});
		if (current?.processingToken !== claim.processingToken) throw new ExportLeaseLostError();
		if (current.status !== ExportJobStatus.PROCESSING) throw new ExportLeaseLostError();
		if (current.cancelRequestedAt) throw new CancelledExportError();
	}

	private async heartbeat(
		claim: ClaimedExport,
		processed: number,
		total: number,
		now: Date,
	): Promise<void> {
		const progress = total === 0 ? 99 : Math.min(99, Math.floor((processed * 100) / total));
		const updated = await this.prisma.exportJob.updateMany({
			where: {
				id: claim.id,
				status: ExportJobStatus.PROCESSING,
				processingToken: claim.processingToken,
				cancelRequestedAt: null,
			},
			data: { heartbeatAt: now, progress },
		});
		if (updated.count === 0) await this.assertActive(claim);
	}

	private async writeChunk(output: PassThrough, chunk: string, signal: AbortSignal): Promise<void> {
		if (signal.aborted || output.destroyed) return;
		if (output.write(chunk)) return;
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				output.off('drain', finish);
				output.off('close', finish);
				output.off('error', fail);
				signal.removeEventListener('abort', finish);
			};
			const finish = () => {
				cleanup();
				resolve();
			};
			const fail = (error: Error) => {
				cleanup();
				reject(error);
			};
			output.once('drain', finish);
			output.once('close', finish);
			output.once('error', fail);
			signal.addEventListener('abort', finish, { once: true });
			if (signal.aborted) finish();
		});
	}

	private async assertMembership(job: ExportJob): Promise<void> {
		const workspace = await this.prisma.workspace.findUnique({ where: { id: job.workspaceId } });
		if (!workspace) throw new PermanentExportError('INVALID_FILTERS');
		const membership = await this.prisma.workspaceMember.findUnique({
			where: {
				userId_workspaceId: {
					userId: job.requestedById,
					workspaceId: job.workspaceId,
				},
			},
		});
		if (!membership) throw new PermanentExportError('MEMBERSHIP_REVOKED');
	}

	private assertFilters(value: unknown): void {
		if (
			typeof value !== 'object' ||
			value === null ||
			!('schemaVersion' in value) ||
			value.schemaVersion !== 1
		) {
			throw new PermanentExportError('INVALID_FILTERS');
		}
	}

	private async cancelQueued(job: ExportJob): Promise<void> {
		if (job.objectKey) await this.storage.remove(job.objectKey);
		const now = new Date();
		await this.prisma.exportJob.updateMany({
			where: { id: job.id, status: ExportJobStatus.QUEUED, cancelRequestedAt: { not: null } },
			data: { status: ExportJobStatus.CANCELLED, finishedAt: now, objectKey: null },
		});
	}

	private async recordQueuedCleanupFailure(job: ExportJob, finalAttempt: boolean): Promise<void> {
		const attempts = job.attempts + 1;
		await this.prisma.exportJob.updateMany({
			where: {
				id: job.id,
				status: ExportJobStatus.QUEUED,
				cancelRequestedAt: { not: null },
			},
			data: finalAttempt
				? {
						status: ExportJobStatus.FAILED,
						attempts,
						errorCode: 'RETRIES_EXHAUSTED',
						finishedAt: new Date(),
					}
				: { attempts, errorCode: 'STORAGE_UNAVAILABLE' },
		});
	}

	private async finishCancelled(claim: ClaimedExport): Promise<void> {
		await this.storage.remove(this.objectKey(claim));
		const cancelled = await this.prisma.exportJob.updateMany({
			where: {
				id: claim.id,
				status: ExportJobStatus.PROCESSING,
				processingToken: claim.processingToken,
				cancelRequestedAt: { not: null },
			},
			data: {
				status: ExportJobStatus.CANCELLED,
				objectKey: null,
				finishedAt: new Date(),
				heartbeatAt: null,
				processingToken: null,
			},
		});
		if (cancelled.count === 0) throw new ExportLeaseLostError();
	}

	private async failQueued(id: string, errorCode: string): Promise<void> {
		await this.prisma.exportJob.updateMany({
			where: { id, status: ExportJobStatus.QUEUED },
			data: { status: ExportJobStatus.FAILED, errorCode, finishedAt: new Date() },
		});
	}

	private async handlePreClaimFailure(
		queueJob: Job<ExportQueuePayload>,
		job: ExportJob,
		error: unknown,
	): Promise<never> {
		if (error instanceof PermanentExportError) {
			await this.failQueued(job.id, error.code);
			throw new UnrecoverableError(error.code);
		}

		const finalAttempt = queueJob.attemptsMade + 1 >= (queueJob.opts.attempts ?? 1);
		const errorCode = finalAttempt ? 'RETRIES_EXHAUSTED' : this.classifyTransient(error);
		await this.prisma.exportJob.updateMany({
			where: { id: job.id, status: ExportJobStatus.QUEUED },
			data: finalAttempt
				? {
						status: ExportJobStatus.FAILED,
						attempts: { increment: 1 },
						errorCode,
						finishedAt: new Date(),
					}
				: { attempts: { increment: 1 }, errorCode },
		});
		throw error instanceof Error ? error : new Error('Unknown pre-claim export failure');
	}

	private async finishFailed(claim: ClaimedExport, errorCode: string): Promise<void> {
		const failed = await this.prisma.exportJob.updateMany({
			where: {
				id: claim.id,
				status: ExportJobStatus.PROCESSING,
				processingToken: claim.processingToken,
			},
			data: {
				status: ExportJobStatus.FAILED,
				errorCode,
				finishedAt: new Date(),
				heartbeatAt: null,
				processingToken: null,
			},
		});
		if (failed.count === 0) throw new ExportLeaseLostError();
	}

	private async finishCleanupFailure(claim: ClaimedExport, finalAttempt: boolean): Promise<void> {
		if (finalAttempt) {
			await this.finishFailed(claim, 'RETRIES_EXHAUSTED');
			return;
		}
		await this.releaseForRetry(claim, 'STORAGE_UNAVAILABLE');
	}

	private async releaseForRetry(claim: ClaimedExport, errorCode: string): Promise<void> {
		const released = await this.prisma.exportJob.updateMany({
			where: {
				id: claim.id,
				status: ExportJobStatus.PROCESSING,
				processingToken: claim.processingToken,
			},
			data: {
				status: ExportJobStatus.QUEUED,
				errorCode,
				heartbeatAt: null,
				processingToken: null,
			},
		});
		if (released.count === 0) throw new ExportLeaseLostError();
	}

	private removeAttemptObject(claim: ExportJob): Promise<void> {
		return this.storage.remove(this.objectKey(claim));
	}

	private objectKey(job: Pick<ExportJob, 'objectKey'>): string {
		if (!job.objectKey) throw new Error('Export attempt has no object key');
		return job.objectKey;
	}

	private isTerminal(status: ExportJobStatus): boolean {
		return (
			status === ExportJobStatus.COMPLETED ||
			status === ExportJobStatus.FAILED ||
			status === ExportJobStatus.CANCELLED
		);
	}

	private classifyTransient(error: unknown): string {
		if (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			typeof error.code === 'string' &&
			error.code.startsWith('P')
		) {
			return 'DATABASE_UNAVAILABLE';
		}
		return 'UPLOAD_FAILED';
	}

	private positiveInteger(config: ConfigService, name: string, fallback: number): number {
		const value = Number(config.get<string>(name) ?? fallback);
		if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be positive`);
		return value;
	}
}
