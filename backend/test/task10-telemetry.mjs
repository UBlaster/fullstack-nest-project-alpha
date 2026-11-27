/* global AbortSignal, URL, URLSearchParams, fetch, process */
import { setTimeout as delay } from 'node:timers/promises';

export class CheckFailure extends Error {}
export function check(value, description) {
	if (!value) throw new CheckFailure(description);
	return value;
}

// This standalone predicate also runs inside the actual API and worker containers.
export function isTestEnvironment(env) {
	try {
		const database = new URL(env.DATABASE_URL);
		const broker = new URL(env.RABBITMQ_URL);
		return (
			database.hostname === 'postgres' &&
			database.pathname === '/task10_pipeline_test' &&
			broker.hostname === 'rabbitmq' &&
			env.EMBEDDING_PROVIDER === 'fake' &&
			(env.EMBEDDING_NEXT_PROVIDER ?? 'fake') === 'fake' &&
			!env.VOYAGE_API_KEY?.trim() &&
			env.EMBEDDING_VERSION === 'v1' &&
			env.EMBEDDING_NEXT_VERSION === 'v2' &&
			env.PIPELINE_QUEUE_NAME === 'task10-pipeline-stages' &&
			env.EXPORT_QUEUE_NAME === 'task10-exports' &&
			env.EXPORT_DLQ_NAME === 'task10-exports-dead'
		);
	} catch {
		return false;
	}
}
export async function until(read, description, timeout = 95_000) {
	const end = Date.now() + timeout;
	do {
		const result = await read();
		if (result) return result;
		await delay(250);
	} while (Date.now() < end);
	throw new CheckFailure('Timeout waiting for ' + description);
}

const objectKeys = new Set();
const fixtureTexts = new Set();
export function rememberFixtureText(text) {
	check(typeof text === 'string' && text.length > 0, 'Missing fixture text');
	fixtureTexts.add(text);
}
export function rememberObjectKey(key) {
	check(typeof key === 'string' && key.length > 0, 'Missing fixture object key');
	objectKeys.add(key);
}
export function safe(text) {
	for (const fixture of fixtureTexts)
		check(!text.includes(fixture), 'Fixture text appeared in telemetry');
	for (const secret of [
		process.env.S3_ACCESS_KEY_ID,
		process.env.S3_SECRET_ACCESS_KEY,
		process.env.VOYAGE_API_KEY,
		...objectKeys,
	]) {
		check(!secret || !text.includes(secret), 'Credential appeared in telemetry');
	}
	check(
		!/T10_PRIVATE_|X-Amz-(?:Signature|Credential)=|Bearer\s+eyJ|eyJ[\w-]+\.eyJ[\w-]+\.|https:\/\/storage.yandexcloud.net\//i.test(
			text,
		),
		'Fixture content or credential-shaped value appeared in telemetry',
	);
}
async function read(url) {
	let response;
	try {
		response = await fetch(url, { signal: AbortSignal.timeout(5000) });
	} catch {
		return null;
	}
	const text = await response.text();
	safe(text);
	return response.ok ? JSON.parse(text) : null;
}
const datasource = { uid: 'workspace-logs', type: 'loki' };
const logQuery = (id) => '{service_name=~"workspace-.+"} | trace_id="' + id + '"';
async function logs(id) {
	const params = new URLSearchParams({ query: logQuery(id), limit: '500' });
	const body = await read(
		'http://grafana:3000/api/datasources/proxy/uid/workspace-logs/loki/api/v1/query_range?' +
			params,
	);
	return (body?.data?.result ?? []).flatMap(({ values }) =>
		values.map(([, line]) => JSON.parse(line)),
	);
}
export function waitLog(id, predicate) {
	return until(async () => (await logs(id)).find(predicate), 'worker log ' + id);
}
export async function evidence(id, metric, options = {}) {
	const {
		pipeline,
		requireVectorShortlist,
		required = [],
		forbidden = [],
		logOperation = 'http.request',
	} = options;
	const trace = await until(async () => {
		const data = (await read('http://jaeger:16686/api/traces/' + id))?.data?.[0];
		if (!data || !required.every((op) => data.spans.some((s) => s.operationName === op))) return;
		if (requireVectorShortlist) {
			const hybrid = data.spans.find((s) => s.operationName === 'search.hybrid');
			if (!hybrid) return;
			const tag = hybrid.tags.find((t) => t.key === 'search.vector.fallback');
			check(
				tag?.type === 'bool' && tag.value === false,
				'Expected workspace-scoped ANN shortlist without exact fallback',
			);
		}
		if (pipeline) {
			const parents = new Map(data.spans.map((s) => [s.spanID, s]));
			const parent = (s) =>
				parents.get(s?.references?.find((r) => r.refType === 'CHILD_OF')?.spanID);
			const stages = data.spans.filter((s) => s.operationName.startsWith('pipeline.'));
			if (
				!stages.some((stage) => {
					const consumer = parent(stage);
					const producer = parent(consumer);
					const dispatch = parent(producer);
					return (
						consumer?.operationName === 'rabbitmq.consume' &&
						producer?.operationName === 'rabbitmq.publish' &&
						dispatch?.operationName === 'outbox.dispatch' &&
						data.processes[consumer.processID].serviceName === 'workspace-worker' &&
						data.processes[producer.processID].serviceName === 'workspace-api'
					);
				})
			)
				return;
		}
		return data;
	}, 'Jaeger ' + id);
	check(
		!trace.spans.some((s) => forbidden.includes(s.operationName)),
		'Unexpected repeated external call',
	);
	check(
		!trace.spans.some((s) =>
			s.tags.some((t) =>
				[
					'db.statement',
					'db.query.text',
					'db.query.params',
					'url.full',
					'http.url',
					'http.request.body',
				].includes(t.key),
			),
		),
		'Sensitive span attribute',
	);
	await waitLog(id, (e) => e.operation === logOperation);
	const query = new URLSearchParams({ query: metric });
	await until(
		async () =>
			(await read('http://prometheus:9090/api/v1/query?' + query))?.data?.result?.some(
				(s) => Number(s.value[1]) > 0,
			),
		'Prometheus ' + metric,
	);
	const panes = {
		logs: {
			datasource: datasource.uid,
			queries: [
				{ refId: 'A', datasource, expr: logQuery(id), editorMode: 'code', queryType: 'range' },
			],
			range: { from: 'now-2h', to: 'now' },
		},
	};
	return {
		jaeger: 'http://localhost:' + (process.env.TASK10_JAEGER_PORT ?? '16686') + '/trace/' + id,
		grafana:
			'http://localhost:' +
			(process.env.TASK10_GRAFANA_PORT ?? '3001') +
			'/explore?' +
			new URLSearchParams({ schemaVersion: '1', panes: JSON.stringify(panes), orgId: '1' }),
		prometheus:
			'http://localhost:' +
			(process.env.TASK10_PROMETHEUS_PORT ?? '9090') +
			'/query?' +
			new URLSearchParams({ 'g0.expr': metric, 'g0.tab': '1' }),
	};
}
