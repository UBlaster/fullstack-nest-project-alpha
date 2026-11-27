import { HttpException } from '@nestjs/common';
import { metrics, Span, SpanOptions, SpanStatusCode, trace } from '@opentelemetry/api';
import { getRequestId } from '../diagnostics/request-context';

export const meter = metrics.getMeter('workspace-docs');
export const tracer = trace.getTracer('workspace-docs');
export const secondsHistogram = {
	unit: 's',
	advice: {
		explicitBucketBoundaries: [
			0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300,
		],
	},
};

export function errorType(error: unknown): string {
	if (error instanceof HttpException) return 'HTTP_' + error.getStatus();
	if (error instanceof TypeError) return 'TypeError';
	if (error instanceof RangeError) return 'RangeError';
	return 'OperationError';
}

// Exception messages can include SQL parameters, URLs or request bodies.
// Only emit locations in this application's compiled/source files.
export function safeFrames(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const locations = (error.stack ?? '')
		.split('\n')
		.slice(1, 16)
		.filter((line) => /^\s+at /.test(line) && !line.includes('node_modules'))
		.map((line) => /(?:[/\\])((?:src|dist)[/\\][\w./\\-]+\.[cm]?[jt]s:\d+:\d+)\)?$/.exec(line)?.[1])
		.filter(Boolean);
	return locations.length ? locations.join('\n') : undefined;
}

export function recordFailure(span: Span | undefined, error: unknown): void {
	if (!span || (error instanceof HttpException && error.getStatus() < 500)) return;
	const type = errorType(error);
	span.recordException({ name: type, message: 'Operation failed', stack: safeFrames(error) });
	span.setAttribute('error.type', type);
	span.setStatus({ code: SpanStatusCode.ERROR });
}

export function withSpan<T>(
	name: string,
	fn: (span: Span) => Promise<T>,
	options: SpanOptions = {},
): Promise<T> {
	return tracer.startActiveSpan(name, options, async (span) => {
		const requestId = getRequestId();
		if (requestId) span.setAttribute('request.id', requestId);
		try {
			return await fn(span);
		} catch (error) {
			recordFailure(span, error);
			throw error;
		} finally {
			span.end();
		}
	});
}
