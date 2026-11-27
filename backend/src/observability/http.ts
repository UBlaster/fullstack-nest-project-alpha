import { AsyncResource } from 'node:async_hooks';
import { STATUS_CODES } from 'node:http';
import {
	ArgumentsHost,
	Catch,
	ExceptionFilter,
	HttpException,
	INestApplication,
} from '@nestjs/common';
import { propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { getRequestId, requestContextMiddleware } from '../diagnostics/request-context';
import { appLogger, logEvent } from './logger';
import { meter, recordFailure, tracer } from './telemetry';

export { appLogger };
const requests = meter.createCounter('workspace.http.requests');
const durations = meter.createHistogram('workspace.http.duration', { unit: 'ms' });
const methods = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']);

function observeHttp(req: Request, res: Response, next: NextFunction): void {
	const method = methods.has(req.method) ? req.method : 'OTHER';
	const parent = propagation.extract(ROOT_CONTEXT, req.headers);
	tracer.startActiveSpan('HTTP ' + method, { kind: SpanKind.SERVER }, parent, (span) => {
		const started = performance.now();
		span.setAttribute('request.id', getRequestId()!);
		let completed = false;
		const finish = AsyncResource.bind(() => {
			if (completed) return;
			completed = true;
			res.off('close', finish);
			res.off('finish', finish);
			// Express Route.path comes from router registration. originalUrl/path
			// contain IDs or tokens, especially on 404s and Stripe return routes.
			const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
			const statusCode = res.writableFinished ? res.statusCode : 499;
			const durationMs = performance.now() - started;
			const labels = { method, route, status_class: Math.floor(statusCode / 100) + 'xx' };
			span.updateName(method + ' ' + route);
			span.setAttributes({
				'http.route': route,
				'http.request.method': method,
				'http.response.status_code': statusCode,
			});
			if (statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
			requests.add(1, labels);
			durations.record(durationMs, labels);
			// The filter reports exceptions here once, with the final status & duration.
			const error: unknown = res.locals.observabilityError;
			logEvent(statusCode >= 500 ? 'error' : 'info', 'http.request', {
				route,
				method,
				statusCode,
				durationMs,
				error,
			});
			span.end();
		});
		res.once('finish', finish);
		res.once('close', finish);
		next();
	});
}

@Catch()
class HttpErrorFilter implements ExceptionFilter {
	catch(error: unknown, host: ArgumentsHost): void {
		const http = host.switchToHttp();
		const response = http.getResponse<Response>();
		const request = http.getRequest<Request>();
		const candidate =
			error instanceof HttpException
				? error.getStatus()
				: error instanceof Error && 'statusCode' in error
					? error.statusCode
					: undefined;
		const status =
			typeof candidate === 'number' &&
			Number.isInteger(candidate) &&
			candidate >= 400 &&
			candidate <= 599
				? candidate
				: 500;
		if (status >= 500) {
			response.locals.observabilityError = error;
			recordFailure(trace.getActiveSpan(), error);
		}
		if (response.headersSent) {
			response.end();
			return;
		}
		// Router misses and parser errors can echo raw URLs, malformed JSON or headers.
		const knownBody =
			request.route && status !== 500 && error instanceof HttpException
				? error.getResponse()
				: undefined;
		// Nest HTTP exceptions have intentional public messages/codes (e.g. the
		// payment retry contract). Unexpected exceptions only expose the request ID.
		const body =
			typeof knownBody === 'object'
				? knownBody
				: {
						message: knownBody ?? STATUS_CODES[status] ?? 'Request failed',
					};
		response.status(status).json({ ...body, statusCode: status, requestId: getRequestId() });
	}
}

export function configureObservability(app: INestApplication): void {
	app.useLogger(appLogger);
	app.use(requestContextMiddleware, observeHttp);
	app.useGlobalFilters(new HttpErrorFilter());
}
