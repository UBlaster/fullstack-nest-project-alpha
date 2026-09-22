export const exportQueueAttempts = 5;
export const exportQueueBackoffMs = 5_000;

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
