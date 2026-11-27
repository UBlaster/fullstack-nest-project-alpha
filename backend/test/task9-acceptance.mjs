import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

const enabled = process.argv.includes('--run');
import { setTimeout as delay } from 'node:timers/promises';

const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

function localOrigin(name, port) {
	let url;
	try {
		url = new URL(process.env[name] ?? 'http://127.0.0.1:' + port);
	} catch {
		assert.fail(name + ' must be a valid local origin');
	}
	assert.ok(
		url.protocol === 'http:' &&
			localHosts.has(url.hostname) &&
			!url.username &&
			!url.password &&
			url.pathname === '/' &&
			!url.search &&
			!url.hash,
		name + ' must be a plain HTTP loopback origin',
	);
	return url.origin;
}

const api = localOrigin('TASK9_API_URL', 3000);
const grafana = localOrigin('TASK9_GRAFANA_URL', 3001);
const jaeger = localOrigin('TASK9_JAEGER_URL', 16686);
const prometheus = localOrigin('TASK9_PROMETHEUS_URL', 9090);
const privateMarker = 'task9-private-' + randomUUID();
const probes = [
	{ method: 'GET', path: '/health', route: '/health', status: 200 },
	{
		method: 'GET',
		path: '/task9-unknown/' + privateMarker + '?token=' + privateMarker,
		route: 'unmatched',
		status: 404,
	},
	{
		method: 'POST',
		path: '/payments/webhooks/stripe',
		route: '/payments/webhooks/stripe',
		status: 503,
		body: JSON.stringify({ probe: privateMarker }),
	},
].map((probe) => ({
	...probe,
	traceId: randomBytes(16).toString('hex'),
	parentId: randomBytes(8).toString('hex'),
	requestId: 'task9-test-' + randomUUID(),
	statusClass: Math.floor(probe.status / 100) + 'xx',
}));

function assertRedacted(text, surface) {
	assert.ok(!text.includes(privateMarker), 'A private test marker reached ' + surface);
}

function parseJson(body, surface) {
	try {
		return JSON.parse(body);
	} catch {
		assert.fail('Expected JSON in ' + surface);
	}
}

async function json(url) {
	const response = await fetch(url, {
		redirect: 'error',
		signal: AbortSignal.timeout(4000),
	}).catch(() => undefined);
	if (!response?.ok) return;
	const body = await response.text();
	assertRedacted(body, 'a telemetry response');
	return parseJson(body, 'the telemetry response');
}

async function waitFor(read, label) {
	const deadline = Date.now() + 35_000;
	do {
		const result = await read();
		if (result) return result;
		await delay(1000);
	} while (Date.now() < deadline);
	assert.fail('No ' + label + ' received from the local observability stack');
}

async function exercise(probe) {
	// The webhook is deliberately unsigned. Configuration or signature checks reject it
	// before contacting Stripe or creating a payment. All probes avoid application DB writes.
	const response = await fetch(api + probe.path, {
		method: probe.method,
		headers: {
			'X-Request-ID': probe.requestId,
			traceparent: ['00', probe.traceId, probe.parentId, '01'].join('-'),
			authorization: 'Bearer ' + privateMarker,
			cookie: 'task9=' + privateMarker,
			'content-type': 'application/json',
		},
		body: probe.body,
		redirect: 'error',
		signal: AbortSignal.timeout(5000),
	});
	assert.equal(
		response.status,
		probe.status,
		probe.status === 503
			? 'Run on the test API with Stripe disabled'
			: probe.method + ' ' + probe.route,
	);
	assert.ok(
		response.headers.get('x-request-id') === probe.requestId,
		'Missing matching X-Request-ID',
	);
	const body = await response.text();
	assertRedacted(body, 'the public HTTP response');
	if (probe.status >= 400) {
		assert.ok(
			parseJson(body, 'the HTTP error response').requestId === probe.requestId,
			'HTTP errors must expose requestId',
		);
	}
}

async function checkSpan(probe) {
	const span = await waitFor(async () => {
		const data = await json(jaeger + '/api/traces/' + probe.traceId);
		return data?.data
			?.flatMap((trace) => trace.spans)
			.find(
				(candidate) =>
					candidate.traceID === probe.traceId &&
					candidate.tags.some(
						({ key, value }) => key === 'request.id' && value === probe.requestId,
					) &&
					candidate.tags.some(({ key }) => key === 'http.response.status_code'),
			);
	}, 'Jaeger HTTP span for ' + probe.status);
	const tags = new Map(span.tags.map(({ key, value }) => [key, value]));
	assert.ok(
		span.operationName === probe.method + ' ' + probe.route,
		'Expected a bounded HTTP span name',
	);
	assert.ok(tags.get('http.route') === probe.route, 'Expected a bounded http.route');
	assert.ok(tags.get('http.response.status_code') === probe.status, 'Wrong span HTTP status');
	assert.ok(
		span.references.some(
			({ refType, spanID }) => refType === 'CHILD_OF' && spanID === probe.parentId,
		),
		'HTTP span lost its incoming W3C parent',
	);
	const exceptions = span.logs.filter(({ fields }) =>
		fields.some(({ key, value }) => key === 'event' && value === 'exception'),
	);
	assert.equal(tags.get('error') === true, probe.status >= 500, 'Wrong span error status');
	assert.equal(
		exceptions.length,
		probe.status >= 500 ? 1 : 0,
		'Wrong number of span exception events',
	);
	return span;
}

async function checkLog(probe, span) {
	const query = '{service_name="workspace-api"} | trace_id="' + probe.traceId + '"';
	const search = new URLSearchParams({ query, limit: '20' });
	const url =
		grafana + '/api/datasources/proxy/uid/workspace-logs/loki/api/v1/query_range?' + search;
	const entries = await waitFor(async () => {
		const response = await json(url);
		const logs = response?.data?.result?.flatMap(({ values }) =>
			values.map(([, body]) => parseJson(body, 'the log record')),
		);
		const correlated = logs?.filter((entry) => entry.operation === 'http.request');
		return correlated?.length ? correlated : undefined;
	}, 'Grafana log for ' + probe.status);
	assert.equal(entries.length, 1, 'The HTTP request must be logged once');
	const [entry] = entries;
	assert.ok(entry.requestId === probe.requestId, 'Log lost its request ID');
	assert.ok(entry.traceId === probe.traceId, 'Log lost its trace ID');
	assert.ok(entry.spanId === span.spanID, 'Log does not correlate with the HTTP span');
	assert.ok(
		entry.statusCode === probe.status && entry.route === probe.route,
		'Wrong log status or route',
	);
	assert.ok(Number.isFinite(entry.durationMs) && entry.durationMs >= 0, 'Missing request duration');
	assert.ok(
		entry.service === 'workspace-api' && entry.method === probe.method,
		'Wrong log service or method',
	);
	assert.ok(
		typeof entry.environment === 'string' && entry.environment.length > 0,
		'Missing log environment',
	);
	assert.ok(
		typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp)),
		'Missing log timestamp',
	);
	assert.ok(
		typeof entry.level === 'string' && (probe.status < 500 || entry.level === 'error'),
		'Wrong log level',
	);
	assert.ok(
		!['authorization', 'cookie', 'body', 'rawBody'].some((key) => Object.hasOwn(entry, key)),
		'An HTTP log contains private fields',
	);
}

async function httpCount(probe) {
	const selector =
		'workspace_http_requests_total' +
		'{method="' +
		probe.method +
		'",route="' +
		probe.route +
		'",status_class="' +
		probe.statusClass +
		'"}';
	const response = await json(
		prometheus + '/api/v1/query?' + new URLSearchParams({ query: selector }),
	);
	if (response?.status !== 'success') return;
	const samples = response.data.result;
	for (const { metric } of samples) {
		assert.ok(
			!Object.keys(metric).some((key) =>
				/^(?:user|workspace|document|request|trace|span|payment|export|session)_?id$/i.test(key),
			),
			'An HTTP metric label contains an identifier',
		);
	}
	return samples.reduce((sum, { value }) => sum + Number(value[1]), 0);
}

test('Task 9 HTTP observability on the local test stand', { skip: !enabled, timeout: 150_000 }, async (t) => {
	const before = new Map();
	for (const probe of probes) {
		const count = await httpCount(probe);
		if (count !== undefined) before.set(probe.status, count);
	}
	for (const probe of probes) {
		await t.test(probe.method + ' ' + probe.route + ' → ' + probe.status, async () => {
			await exercise(probe);
			const span = await checkSpan(probe);
			await Promise.all([
				checkLog(probe, span),
				waitFor(async () => {
					const count = await httpCount(probe);
					return count !== undefined && count > (before.get(probe.status) ?? 0);
				}, 'Prometheus counter increase for ' + probe.status),
			]);
		});
	}
});
