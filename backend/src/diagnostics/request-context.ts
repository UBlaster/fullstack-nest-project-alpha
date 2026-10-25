import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

const requestContext = new AsyncLocalStorage<{ requestId: string }>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getRequestId(): string | undefined {
	return requestContext.getStore()?.requestId;
}

export function requestContextMiddleware(
	request: Request,
	response: Response,
	next: NextFunction,
): void {
	const incoming = request.headers['x-request-id'];
	const requestId =
		typeof incoming === 'string' && uuidPattern.test(incoming)
			? incoming.toLowerCase()
			: randomUUID();
	response.setHeader('X-Request-ID', requestId);
	requestContext.run({ requestId }, next);
}
