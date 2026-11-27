import { DocumentVersionStatus, PipelineStage, PipelineStageRun, Prisma } from '@prisma/client';
import { messageHeaders } from '../observability/carrier';

export const STAGES = ['EXTRACT', 'NORMALIZE', 'CHUNK', 'EMBED', 'INDEX', 'ACTIVATE'] as const;
export const STAGE_STATUS: Record<PipelineStage, DocumentVersionStatus> = {
	EXTRACT: 'EXTRACTING',
	NORMALIZE: 'NORMALIZING',
	CHUNK: 'CHUNKING',
	EMBED: 'EMBEDDING',
	INDEX: 'EMBEDDING',
	ACTIVATE: 'INDEXED',
};

export const PIPELINE_VERSION = 'v1.utf8-poppler.whitespace.chars4.800-100';
export class InvalidSourceError extends Error {}
export class LeaseLostError extends Error {}

export async function enqueueFirstDelivery(
	tx: Prisma.TransactionClient,
	versionId: string,
	stage: PipelineStage,
	inputHash: string,
) {
	const run = await tx.pipelineStageRun.create({ data: { versionId, stage, inputHash } });
	return dispatchStage(tx, run, 'stage');
}

export async function dispatchStage(
	tx: Prisma.TransactionClient,
	run: PipelineStageRun,
	delivery: 'stage' | 'retry' | 'dead',
	carrier = messageHeaders(),
) {
	const { dispatch } = await tx.pipelineStageRun.update({
		where: { id: run.id },
		data: { dispatch: { increment: 1 } },
		select: { dispatch: true },
	});
	const aggregateId = run.id + ':' + dispatch;
	await tx.outboxEvent.create({
		data: {
			type: 'PIPELINE_STAGE',
			aggregateId,
			payload: {
				documentVersionId: run.versionId,
				stage: run.stage,
				inputHash: run.inputHash,
				carrier,
				delivery,
				...(delivery === 'retry' ? { retryNumber: run.attempts } : {}),
				...(delivery === 'dead' ? { errorCode: run.errorCode ?? 'FAILED' } : {}),
			},
		},
	});
	return aggregateId;
}
