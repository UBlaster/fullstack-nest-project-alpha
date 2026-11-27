import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Logger } from '@nestjs/common';
import { context, createContextKey, SpanKind } from '@opentelemetry/api';
import type { S3Client } from '@aws-sdk/client-s3';
import { traceHeaders } from '../observability/carrier';
import { meter, secondsHistogram, withSpan } from '../observability/telemetry';
import { getRequestId } from './request-context';

const logger = new Logger('S3Operations');
const networkCall = createContextKey('s3.networkCall');
const duration = meter.createHistogram('s3.duration', secondsHistogram);
const errors = meter.createCounter('s3.errors');
type S3Operation =
	| 'PutObject'
	| 'PresignPutObject'
	| 'PresignGetObject'
	| 'DeleteObject'
	| 'ListObjectsV2'
	| 'HeadObject'
	| 'AbortMultipartUpload'
	| 'CompleteMultipartUpload'
	| 'UploadPart'
	| 'CreateMultipartUpload';

export function addS3Propagation(client: S3Client): S3Client {
	// Build runs before the SDK signs the request. Presigning is local and must never
	// require a future browser download to replay our trace headers.
	client.middlewareStack.add(
		(next) => async (args) => {
			if (context.active().getValue(networkCall)) {
				const request = args.request as { headers: Record<string, string> };
				Object.assign(request.headers, traceHeaders());
			}
			return next(args);
		},
		{ step: 'build', name: 'workspaceTraceHeaders' },
	);
	return client;
}

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

export async function observeS3<T>(
	operation: S3Operation,
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
			return;
		}
	};
	return withSpan(
		`s3.${operation}`,
		async (span) => {
			span.setAttribute('request.id', requestId);
			try {
				const result = await context.with(
					context.active().setValue(networkCall, !options.presign),
					work,
				);
				log('success', result);
				return result;
			} catch (error) {
				errors.add(1, { operation });
				log('error', error);
				throw error;
			} finally {
				duration.record((performance.now() - started) / 1000, { operation });
			}
		},
		{ kind: options.presign ? SpanKind.INTERNAL : SpanKind.CLIENT },
	);
}
