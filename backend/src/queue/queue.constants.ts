import type { PipelineStage } from '@prisma/client';

export const exportQueueAttempts = 5;
export const exportQueueBackoffMs = 5_000;

export interface ExportQueueJob {
	data: ExportQueuePayload;
	attemptsMade: number;
}

export interface ExportQueuePayload {
	exportJobId: string;
	schemaVersion: 1;
}

export interface ExportDeadLetterPayload {
	exportJobId: string;
	sourceQueueJobId: string;
	attempts: number;
	errorCode: string;
}

export const pipelineRetries = 5;

export interface PipelineJob {
	documentVersionId: string;
	stage: PipelineStage;
	inputHash: string;
}

export type PipelineDestination = 'stage' | 'retry' | 'dead';

export function parsePipelineJob(value: unknown): PipelineJob {
	if (
		!value ||
		typeof value !== 'object' ||
		!('documentVersionId' in value) ||
		typeof value.documentVersionId !== 'string' ||
		!/^[\w-]{1,128}$/.test(value.documentVersionId) ||
		!('stage' in value) ||
		typeof value.stage !== 'string' ||
		!['EXTRACT', 'NORMALIZE', 'CHUNK', 'EMBED', 'INDEX', 'ACTIVATE'].includes(value.stage) ||
		!('inputHash' in value) ||
		typeof value.inputHash !== 'string' ||
		!/^[a-f0-9]{64}$/.test(value.inputHash)
	)
		throw new Error('InvalidPipelineJob');
	return {
		documentVersionId: value.documentVersionId,
		stage: value.stage as PipelineStage,
		inputHash: value.inputHash,
	};
}
