// Run from the repository root after the Task 9 services are healthy in the project Compose group.
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const compose = [
	'compose',
	'-p',
	'nest-fullstack-project',
	'-f',
	'docker-compose.yml',
	'-f',
	'observability/compose.test.yml',
];
const forbidden =
	/OBS9_PRIVATE_|Bearer\s+eyJ|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+|sk_(?:test|live)_\w{8}|whsec_\w{8}|t=\d+,v1=|X-Amz-(?:Signature|Credential)=|https:\/\/checkout\.stripe\.com\/|@example\.test|\$2[aby]\$\d{2}\$/i;

function check(ok, description) {
	if (!ok) throw new Error(description);
}
function safe(text, source) {
	check(!forbidden.test(text), 'Sensitive marker or credential-shaped value in ' + source);
}
function docker(args) {
	const result = spawnSync('docker', [...compose, ...args], {
		encoding: 'utf8',
		timeout: 150_000,
		maxBuffer: 32 * 1024 * 1024,
	});
	safe((result.stdout ?? '') + (result.stderr ?? ''), args[0] + ' output');
	check(
		result.status === 0,
		'Compose ' + args[0] + ' failed. Check the Task 9 services and the smoke command.',
	);
	return result.stdout;
}
function summary(output, predicate) {
	for (const line of output.trim().split(/\r?\n/).reverse()) {
		if (!line.startsWith('{')) continue;
		const entry = JSON.parse(line);
		if (predicate(entry)) return entry;
	}
	throw new Error('Missing smoke result');
}
async function fetchJson(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
	if (!response.ok) return;
	const body = await response.text();
	safe(body, 'telemetry response');
	return JSON.parse(body);
}
async function waitFor(read, description) {
	const until = Date.now() + 45_000;
	do {
		const value = await read();
		if (value) return value;
		await delay(1000);
	} while (Date.now() < until);
	throw new Error('Timed out waiting for ' + description);
}
const endpoints = new Map();
function hostUrl(service, internalPort) {
	if (!endpoints.has(service)) {
		const binding = docker(['port', service, String(internalPort)]).trim();
		const port = /:(\d+)$/m.exec(binding)?.[1];
		check(port && Number(port) > 0 && Number(port) <= 65535, 'Missing published port for ' + service);
		endpoints.set(service, 'http://127.0.0.1:' + port);
	}
	return endpoints.get(service);
}
const logsDatasource = { type: 'loki', uid: 'workspace-logs' };

function traceLogQuery(traceId) {
	return `{service_name=~"workspace-.+"} | trace_id="${traceId}"`;
}

function grafanaLogsUrl(traceId) {
	const panes = {
		logs: {
			datasource: logsDatasource.uid,
			queries: [
				{
					refId: 'A',
					datasource: logsDatasource,
					expr: traceLogQuery(traceId),
					editorMode: 'code',
					queryType: 'range',
				},
			],
			range: { from: 'now-1h', to: 'now' },
		},
	};
	return (
		hostUrl('grafana', 3000) +
		'/explore?' +
		new URLSearchParams({ schemaVersion: '1', panes: JSON.stringify(panes), orgId: '1' })
	);
}

async function verifyGrafanaLog(stage) {
	const params = new URLSearchParams({ query: traceLogQuery(stage.traceId), limit: '20' });
	const queryUrl =
		hostUrl('grafana', 3000) +
		'/api/datasources/proxy/uid/' +
		logsDatasource.uid +
		'/loki/api/v1/query_range?' +
		params;
	const status = stage.step === 'missing' ? 404 : 503;
	await waitFor(async () => {
		const streams = (await fetchJson(queryUrl))?.data?.result ?? [];
		return streams.some(
			({ stream, values }) =>
				stream.service_name === 'workspace-api' &&
				values.some(([, body]) => {
					const entry = JSON.parse(body);
					return (
						entry.operation === 'http.request' &&
						entry.requestId === stage.requestId &&
						entry.traceId === stage.traceId &&
						entry.statusCode === status &&
						/^[a-f0-9]{16}$/.test(entry.spanId)
					);
				}),
		);
	}, 'Grafana log for ' + stage.step);
}

const metricPattern =
	'workspace_http_.*|workspace_db_.*|redis_.*|cache_.*|external_.*|payment_.*|export_.*|s3_.*';
async function verifyMetrics(cloudExport) {
	const selector = '{__name__=~"' + metricPattern + '"}';
	const required = [
		'workspace_http_requests_total',
		'workspace_db_duration_milliseconds_count',
		'export_queue_depth',
		'cache_lookups_total',
		'payment_webhooks_total',
		'payment_reconciliations_total',
		'external_duration_milliseconds_count',
	];
	if (cloudExport) required.push('export_duration_seconds_count', 's3_duration_seconds_count');
	const series = await waitFor(async () => {
		const data =
			(
				await fetchJson(
					hostUrl('prometheus', 9090) + '/api/v1/' +
						'series?match[]=' +
						encodeURIComponent(selector) +
						'&start=' +
						(Math.floor(Date.now() / 1000) - 300),
				)
			)?.data ?? [];
		const metrics = new Set(data.map((row) => row.__name__));
		return required.every((key) => metrics.has(key)) && data;
	}, 'application metrics');
	for (const labels of series) {
		check(
			!Object.keys(labels).some((key) =>
				/(?:^|_)(?:request|user|workspace|document|trace|span|export|payment|session)_?id$|^url$|^key$/i.test(
					key,
				),
			),
			'Unexpected identifier label',
		);
		check(
			!Object.values(labels).some((value) =>
				/[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-f]{32}$|\?/.test(value),
			),
			'Unexpected identifier or query in metric labels',
		);
	}
	return series.length;
}
async function verifyTrace(stage, required, paymentId) {
	check(/^[a-f0-9]{32}$/.test(stage.traceId), 'Invalid trace ID');
	const result = await waitFor(
		async () => {
			const trace = (await fetchJson(hostUrl('jaeger', 16686) + '/api/traces/' + stage.traceId))?.data?.[0];
			return (
				trace &&
				required.every((operation) => trace.spans.some((s) => s.operationName === operation)) &&
				trace
			);
		},
		'Jaeger spans ' + required.join(', '),
	);
	const hasTag = (key, value) =>
		result.spans.some((s) => s.tags.some((t) => t.key === key && t.value === value));
	check(hasTag('request.id', stage.requestId), 'Request ID missing from trace');
	if (paymentId) check(hasTag('payment.id', paymentId), 'Payment correlation missing');
	for (const span of result.spans) {
		check(
			!span.tags.some((tag) =>
				[
					'db.statement',
					'db.query.text',
					'db.query.params',
					'url.full',
					'http.url',
					'http.request.body',
				].includes(tag.key),
			),
			'Sensitive trace attribute',
		);
	}
	if (stage.step === 'unconfigured' || stage.step === 'missing') {
		const root = result.spans.find((s) => s.operationName === required[0]);
		const exception = root.logs.some((event) =>
			event.fields.some((field) => field.key === 'event' && field.value === 'exception'),
		);
		check(exception === (stage.step === 'unconfigured'), 'Unexpected exception event');
		check(
			root.tags.some((t) => t.key === 'error' && t.value === true) ===
				(stage.step === 'unconfigured'),
			'Unexpected HTTP span error status',
		);
	}
	if (stage.step === 'scheduled') {
		check(
			hasTag('payment.source', 'scheduled') &&
				Object.values(result.processes).some(
					(p) => p.serviceName === 'workspace-payment-worker-smoke',
				),
			'Missing scheduled worker boundary',
		);
	}
	if (stage.step === 'export') {
		const producer = result.spans.find((s) => s.operationName === 'rabbitmq.publish');
		const consumer = result.spans.find((s) => s.operationName === 'rabbitmq.consume');
		check(
			consumer.references.some(
				(ref) => ref.spanID === producer.spanID && ref.refType === 'CHILD_OF',
			),
			'Consumer lost producer parent',
		);
		check(
			result.processes[producer.processID].serviceName === 'workspace-api' &&
				result.processes[consumer.processID].serviceName === 'workspace-worker',
			'Missing API/worker boundary',
		);
	}
	return {
		step: stage.step,
		requestId: stage.requestId,
		traceId: stage.traceId,
		jaegerUrl: hostUrl('jaeger', 16686) + '/trace/' + stage.traceId,
		grafanaLogsUrl: grafanaLogsUrl(stage.traceId),
		spans: result.spans.length,
		operations: [...new Set(result.spans.map((s) => s.operationName))].sort(),
	};
}

async function run() {
	const since = new Date().toISOString();
	const outage = process.argv.includes('--outage');
	const cloudExport = process.argv.includes('--export');
	if (outage) {
		check(
			!docker(['ps', '--status', 'running', '--quiet', 'otel-collector']).trim(),
			'Stop the project Collector before the outage check',
		);
	}
	const smokeCommand = ['exec', '-T', 'backend', 'node', 'test/task9-export-smoke.mjs'];
	if (cloudExport) smokeCommand.push('--export');
	const smoke = summary(docker(smokeCommand), (value) => Array.isArray(value.failures));
	check(!cloudExport || smoke.csvVerified, 'Yandex Object Storage export was not verified');
	const payment = summary(
		docker([
			'exec',
			'-T',
			'-e',
			'OTEL_SERVICE_NAME=workspace-payment-smoke',
			'backend',
			'node',
			'-r',
			'ts-node/register/transpile-only',
			'test/task9-payment-smoke.ts',
		]),
		(value) => value.scenario === 'task9-payment-stub',
	);
	if (outage) {
		console.log(
			JSON.stringify({
				collector: 'unreachable',
				export: smoke.status ?? 'skipped',
				csvVerified: smoke.csvVerified ?? false,
				payment: payment.status,
				sse: payment.sse,
				sdk: payment.sdk,
			}),
		);
		return;
	}
	const traces = [];
	if (cloudExport) {
		traces.push(
			await verifyTrace({ ...smoke, step: 'export' }, [
				'outbox.dispatch',
				'rabbitmq.publish',
				'rabbitmq.wait',
				'rabbitmq.consume',
				'export.process',
				'export.csv',
				's3.PutObject',
			]),
		);
	}
	const expected = {
		create: ['payment.reserve', 'payment.dispatch', 'stripe.checkout.create', 'payment.transition'],
		reconcile: ['payment.reconcile', 'stripe.checkout.retrieve', 'payment.transition'],
		scheduled: ['payment.reconcile', 'stripe.checkout.retrieve', 'payment.transition'],
		webhook: ['payment.webhook', 'stripe.checkout.retrieve', 'payment.transition'],
		events: ['GET /payments/:id/events', 'payment.sse.snapshot'],
	};
	for (const stage of payment.traces)
		traces.push(await verifyTrace(stage, expected[stage.step], payment.paymentId));
	for (const stage of smoke.failures)
		traces.push(
			await verifyTrace(stage, [
				stage.step === 'missing' ? 'GET unmatched' : 'POST /workspaces/:workspaceId/payments',
			]),
		);
	const series = await verifyMetrics(cloudExport);
	const logs = docker(['logs', '--no-log-prefix', '--since', since, 'backend', 'worker']).split(
		/\r?\n/,
	);
	const hasLog = ({ requestId, traceId }, operation) =>
		logs.some(
			(line) =>
				line.includes(requestId) && line.includes(traceId) && line.includes('"' + operation + '"'),
		);
	check(
		smoke.failures.every((stage) => hasLog(stage, 'http.request')),
		'Missing correlated HTTP logs',
	);
	await Promise.all(smoke.failures.map(verifyGrafanaLog));
	if (cloudExport)
		check(
			['http.request', 'rabbitmq.publish', 'rabbitmq.consume'].every((name) => hasLog(smoke, name)),
			'Missing correlated export logs',
		);
	console.log(
		JSON.stringify(
			{
				paymentId: payment.paymentId,
				paymentStatus: payment.status,
				sdk: payment.sdk,
				sse: payment.sse,
				exportStatus: smoke.status ?? 'skipped',
				csvVerified: smoke.csvVerified ?? false,
				checkedSeries: series,
				checkedGrafanaLogs: smoke.failures.length,
				traces,
			},
			null,
			2,
		),
	);
}
run().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
