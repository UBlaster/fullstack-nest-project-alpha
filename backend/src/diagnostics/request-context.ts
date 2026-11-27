import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

interface RequestContext {
	requestId: string;
	userId?: string;
	workspaceId?: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

export function safeRequestId(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(value) &&
		!/^(?:eyJ[^.]*\.[^.]+\.|(?:sk|rk|pk|cs)_(?:test|live)_|whsec_)/i.test(value)
	);
}

export function runWithRequestId<T>(value: unknown, fn: () => T): T {
	return requestContext.run({ requestId: safeRequestId(value) ? value : randomUUID() }, fn);
}

export function getRequestContext() {
	return requestContext.getStore();
}

export function setAuthenticatedContext(ids: { userId: string; workspaceId?: string }): void {
	const current = getRequestContext();
	if (current) Object.assign(current, ids);
}

export function getRequestId(): string | undefined {
	return requestContext.getStore()?.requestId;
}

export function requestContextMiddleware(
	request: Request,
	response: Response,
	next: NextFunction,
): void {
	runWithRequestId(request.headers['x-request-id'], () => {
		response.setHeader('X-Request-ID', getRequestId()!);
		next();
	});
}
