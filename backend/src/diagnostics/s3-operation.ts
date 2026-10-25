import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Logger } from '@nestjs/common';
import { getRequestId } from './request-context';

const logger = new Logger('S3Operations');

function record(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function identifier(value: unknown): string | null {
	return typeof value === 'string' && /^[a-zA-Z0-9+/=_.-]{1,200}$/.test(value) ? value : null;
}

function integer(
	value: unknown,
	minimum: number,
	maximum = Number.MAX_SAFE_INTEGER,
): number | null {
	return typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= minimum &&
		value <= maximum
		? value
		: null;
}

/** Observability only: no retries, SDK input/output dumps, or replacement errors. */
export async function observeS3<T>(
	operation: string,
	work: () => Promise<T>,
	options: { requestId?: string; presign?: boolean } = {},
): Promise<T> {
	const requestId = options.requestId ?? getRequestId() ?? randomUUID();
	const started = performance.now();
	const log = (outcome: 'success' | 'error', value: unknown) => {
		try {
			const object = record(value);
			const metadata = record(object.$metadata);
			const entry = JSON.stringify({
				event: 's3.operation',
				requestId,
				operation,
				kind: options.presign ? 'presign' : 'request',
				outcome,
				durationMs: Math.round((performance.now() - started) * 100) / 100,
				httpStatusCode: integer(metadata.httpStatusCode, 100, 599),
				errorCode:
					outcome === 'error' ? identifier(object.Code ?? object.code ?? object.name) : null,
				awsRequestId: identifier(metadata.requestId),
				attempts: options.presign ? 0 : integer(metadata.attempts, 1),
			});
			if (outcome === 'error') logger.error(entry);
			else logger.log(entry);
		} catch {
			// Logging must never change the result of an S3 operation.
		}
	};
	let result: T;
	try {
		result = await work();
	} catch (error) {
		log('error', error);
		throw error;
	}
	log('success', result);
	return result;
}
