import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, Span } from '@opentelemetry/sdk-trace-base';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { getRequestId } from './diagnostics/request-context';
import { environmentName, serviceName } from './observability/resource';

class ApplicationSpanProcessor extends BatchSpanProcessor {
	override onStart(span: Span) {
		const requestId = getRequestId();
		if (requestId) span.setAttribute('request.id', requestId);
		if (span.instrumentationScope.name === 'prisma') {
			span.setAttribute('db.system.name', 'postgresql');
		}
	}
}

// This project uses only the Compose collector or a collector on loopback.
function localEndpoint(): string | undefined {
	const value = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://127.0.0.1:4318';
	if (value === 'http://otel-collector:4318') return value;
	if (/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9]\d{0,4}$/.test(value)) {
		try {
			return new URL(value).origin;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

const endpoint = localEndpoint();
const configuredInterval = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 15000);
const interval = Number.isFinite(configuredInterval) ? Math.max(1000, configuredInterval) : 15000;
const batchOptions = {
	maxQueueSize: 1024,
	maxExportBatchSize: 128,
	scheduledDelayMillis: 1000,
	exportTimeoutMillis: 2000,
};
const sdk = new NodeSDK({
	resource: resourceFromAttributes({
		'service.name': serviceName,
		'deployment.environment.name': environmentName,
	}),
	autoDetectResources: false,
	textMapPropagator: new W3CTraceContextPropagator(),
	logRecordProcessors: endpoint
		? [
				new BatchLogRecordProcessor(
					new OTLPLogExporter({ url: endpoint + '/v1/logs', timeoutMillis: 1500 }),
					batchOptions,
				),
			]
		: [],
	spanProcessors: endpoint
		? [
				new ApplicationSpanProcessor(
					new OTLPTraceExporter({ url: endpoint + '/v1/traces', timeoutMillis: 1500 }),
					batchOptions,
				),
			]
		: [],
	metricReaders: endpoint
		? [
				new PeriodicExportingMetricReader({
					exporter: new OTLPMetricExporter({
						url: endpoint + '/v1/metrics',
						timeoutMillis: Math.min(1500, interval),
					}),
					exportIntervalMillis: interval,
					exportTimeoutMillis: Math.min(2000, interval),
				}),
			]
		: [],
	instrumentations: [
		// These Prisma 6 client spans contain static model/method names. Engine and
		// raw-query attributes can contain SQL or literals, including in errors.
		new PrismaInstrumentation({
			ignoreSpanTypes: [/^(?!prisma:client:(operation|transaction|connect)$)/],
		}),
	],
});
sdk.start();

let shutdown: Promise<void> | undefined;
export function shutdownTelemetry(): Promise<void> {
	return (shutdown ??= new Promise<void>((resolve) => {
		const timeout = setTimeout(resolve, 3000);
		timeout.unref();
		void sdk
			.shutdown()
			.catch(() => {})
			.finally(() => {
				clearTimeout(timeout);
				resolve();
			});
	}));
}
