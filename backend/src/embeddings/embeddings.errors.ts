class EmbeddingError extends Error {
	constructor(
		message: string,
		readonly httpStatus?: number,
	) {
		super(message);
	}
}

export class EmbeddingValidationError extends EmbeddingError {}
export class EmbeddingTemporaryError extends EmbeddingError {
	constructor(
		message: string,
		httpStatus?: number,
		readonly retryAt?: number,
	) {
		super(message, httpStatus);
	}
}

export function rolloutHttpFailure(error: unknown) {
	if (!(error instanceof EmbeddingError)) return undefined;
	const status = error.httpStatus;
	if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599)
		return undefined;
	return { error: 'EMBEDDING_ROLLOUT_FAILED', httpStatus: status };
}
