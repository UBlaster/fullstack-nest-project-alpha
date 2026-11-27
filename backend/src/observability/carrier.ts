import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { getRequestId, runWithRequestId } from '../diagnostics/request-context';

export function traceHeaders(): Record<string, string> {
	const carrier: Record<string, string> = {};
	propagation.inject(context.active(), carrier);
	const headers: Record<string, string> = {};
	if (carrier.traceparent) headers.traceparent = carrier.traceparent;
	if (carrier.tracestate) headers.tracestate = carrier.tracestate;
	return headers;
}

export function messageHeaders(): Record<string, string> {
	const headers = traceHeaders();
	const requestId = getRequestId();
	if (requestId) headers['x-request-id'] = requestId;
	return headers;
}

export function withMessageContext<T>(source: unknown, fn: () => T): T {
	const fields = source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
	const headers: Record<string, string> = {};
	for (const name of ['traceparent', 'tracestate']) {
		const value = fields[name];
		if (typeof value === 'string' && value.length <= 512) headers[name] = value;
	}
	const parent = propagation.extract(ROOT_CONTEXT, headers);
	return context.with(parent, () => runWithRequestId(fields['x-request-id'], fn));
}
