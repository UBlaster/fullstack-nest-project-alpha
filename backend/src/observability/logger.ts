import type { LoggerService } from '@nestjs/common';
import { context, trace, isSpanContextValid } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import pino from 'pino';
import { getRequestContext, safeRequestId } from '../diagnostics/request-context';
import { errorType, safeFrames } from './telemetry';
import { environmentName, serviceName } from './resource';

type Level = 'info' | 'warn' | 'error' | 'debug';
const otelLogger = logs.getLogger('workspace-docs');
const severity = {
	debug: SeverityNumber.DEBUG,
	info: SeverityNumber.INFO,
	warn: SeverityNumber.WARN,
	error: SeverityNumber.ERROR,
};
const secretFields = [
	'password',
	'passwordConfirmation',
	'hash',
	'token',
	'authorization',
	'cookie',
	'signature',
	'secret',
	'presignedUrl',
	'checkoutUrl',
	'url',
	'body',
	'content',
	'rawBody',
];
const logger = pino({
	base: { service: serviceName, environment: environmentName },
	timestamp: () => ',"timestamp":' + JSON.stringify(new Date().toISOString()),
	formatters: { level: (level) => ({ level }) },
	hooks: {
		// Pino invokes this hook on the serialized, redacted stdout line.
		streamWrite(line) {
			try {
				if (otelLogger.enabled()) {
					const { level, timestamp }: { level: Level; timestamp: string } = JSON.parse(line);
					otelLogger.emit({
						body: line.trimEnd(),
						timestamp: new Date(timestamp),
						severityText: level.toUpperCase(),
						severityNumber: severity[level],
						context: context.active(),
					});
				}
			} catch {
				// A telemetry failure must not interrupt the request or the stdout write.
			}
			return line;
		},
	},
	redact: {
		paths: [
			...secretFields,
			...secretFields.map((key) => '*.' + key),
			'req.headers',
			'res.headers',
		],
		remove: true,
	},
});

// Values for route, result and operation are supplied by instrumentation at the
// call site. Never accept request/response objects or free-form exception text.
export function logEvent(
	level: Level,
	operation: string,
	fields: Record<string, unknown> = {},
): void {
	const current = getRequestContext();
	const active = trace.getActiveSpan()?.spanContext();
	const validSpan = active && isSpanContextValid(active) ? active : undefined;
	const entry: Record<string, unknown> = {
		operation,
		requestId: current?.requestId ?? (safeRequestId(fields.requestId) ? fields.requestId : null),
		traceId: validSpan?.traceId ?? null,
		spanId: validSpan?.spanId ?? null,
		durationMs: null,
		statusCode: null,
	};
	if (current?.userId && safeRequestId(current.userId)) entry.userId = current.userId;
	if (current?.workspaceId && safeRequestId(current.workspaceId))
		entry.workspaceId = current.workspaceId;
	for (const key of [
		'event',
		'result',
		'method',
		'kind',
		'outcome',
		'release',
		'role',
		'errorCode',
		'context',
		'instance',
		'paymentId',
		'exportJobId',
	]) {
		if (safeRequestId(fields[key])) entry[key] = fields[key];
	}
	for (const key of ['durationMs', 'statusCode', 'httpStatusCode', 'attempts', 'count']) {
		if (typeof fields[key] === 'number' && Number.isFinite(fields[key])) entry[key] = fields[key];
	}
	if (fields.source === 'create' || fields.source === 'manual' || fields.source === 'scheduled') {
		entry.source = fields.source;
	}
	if (typeof fields.route === 'string' && /^[\w/.:*-]{1,180}$/.test(fields.route))
		entry.route = fields.route;
	if (
		typeof fields.awsRequestId === 'string' &&
		/^[a-zA-Z0-9+/=_.-]{1,200}$/.test(fields.awsRequestId)
	) {
		entry.awsRequestId = fields.awsRequestId;
	}
	if (fields.error !== undefined) {
		entry['error.type'] = errorType(fields.error);
		entry.stack = safeFrames(fields.error);
	}
	logger[level](entry);
}

// Nest and SDK errors may carry credentials in message, stack, headers or body.
// Keep structured diagnostics from known application loggers; discard free text.
function nestLog(level: Level, message: unknown, optional: unknown[]): void {
	const context = optional[optional.length - 1];
	if (
		typeof message === 'string' &&
		(context === 'S3Operations' || context === 'DocumentResponse' || context === 'Release')
	) {
		try {
			const entry = JSON.parse(message);
			if (entry.event === 's3.operation' && safeRequestId(entry.operation)) {
				logEvent(level, 's3.' + entry.operation, entry);
				return;
			}
			if (entry.event === 'document.text.integrity_error' || entry.event === 'release_started') {
				logEvent(level, entry.event, entry);
				return;
			}
		} catch {
			/* Fall through to bounded framework fields. */
		}
	}
	const knownMessages: Record<string, string> = {
		'RabbitMQ connection error': 'rabbitmq.connection.error',
		'RabbitMQ publisher channel error': 'rabbitmq.publisher.error',
		'RabbitMQ consumer channel error': 'rabbitmq.consumer.error',
		'RabbitMQ consumer unavailable; reconnecting': 'rabbitmq.consumer.reconnect',
		'RabbitMQ delivery unfinished; requeueing on channel close': 'rabbitmq.delivery.requeue',
		'Payment maintenance unavailable': 'payment.maintenance.unavailable',
		'Payment recovery deferred': 'payment.recovery.deferred',
		'Payment event recovery deferred': 'payment.event.deferred',
		'Test payments are not configured; document and export features remain available':
			'payment.unconfigured',
		'CSV export failed after the response started': 'export.stream.error',
	};
	const operation =
		typeof message === 'string' && Object.prototype.hasOwnProperty.call(knownMessages, message)
			? knownMessages[message]
			: 'nest.' + level;
	logEvent(level, operation, { context });
}

export const appLogger: LoggerService = {
	log: (message, ...args) => nestLog('info', message, args),
	error: (message, ...args) => nestLog('error', message, args),
	warn: (message, ...args) => nestLog('warn', message, args),
	debug: (message, ...args) => nestLog('debug', message, args),
	verbose: (message, ...args) => nestLog('debug', message, args),
};
