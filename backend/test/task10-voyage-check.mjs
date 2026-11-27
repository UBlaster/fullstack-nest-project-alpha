/* global URL, URLSearchParams, console, process */
import { setTimeout as delay } from 'node:timers/promises';
import {
	api,
	db,
	document,
	indexed,
	owner,
	traces,
	upload,
	version,
} from './task10-api-fixtures.mjs';
import { check, CheckFailure, evidence, rememberFixtureText } from './task10-telemetry.mjs';

// Live acceptance uses two synthetic texts. The search terms appear in neither title.
const fixtures = [
	{
		title: 'Памятка 17',
		text: 'Резервные копии хранятся на внешнем диске. При отказе компьютера файлы можно восстановить из последнего снимка.',
	},
	{
		title: 'Памятка 23',
		text: 'Рассаду томатов высаживают в политую почву. Для роста растениям нужны свет и тепло.',
	},
];
const readVersion = 'voyage-4-v1';

async function run() {
	const database = new URL(process.env.DATABASE_URL);
	check(
		database.hostname === 'postgres' && database.pathname === '/task10_pipeline_test',
		'Select the Task 10 test database',
	);
	check(
		process.env.EMBEDDING_NEXT_PROVIDER === 'voyage' &&
			process.env.EMBEDDING_NEXT_VERSION === readVersion,
		'Select the Voyage rollout profile',
	);
	const policy = await db.embeddingReadConfig.findUniqueOrThrow({ where: { id: 'default' } });
	check(
		policy.embeddingVersion === readVersion && policy.writeVersions.includes(readVersion),
		'Voyage read/write policy is required',
	);

	const user = await owner();
	const documents = [];
	const versions = [];
	for (const fixture of fixtures) {
		rememberFixtureText(fixture.text.split('.')[0]);
		const id = await document(user, fixture.title);
		const file = await upload(user, id, fixture.text);
		const pending = await version(user, id, file);
		await indexed(user, pending, 210_000);
		const [row] = await db.$queryRaw`
			SELECT e.model, vector_dims(e.embedding) AS dimensions
			FROM "DocumentEmbedding" e JOIN "DocumentChunk" c ON c.id = e."chunkId"
			WHERE c."versionId" = ${pending.versionId} AND e."embeddingVersion" = ${readVersion} AND e.status = 'READY'
			LIMIT 1`;
		check(
			row?.model === 'voyage-4' && row.dimensions === 1024,
			'Expected an indexed Voyage document vector',
		);
		documents.push(id);
		versions.push(pending);
	}
	const query = 'Как вернуть потерянные данные, если сломался ноутбук?';
	rememberFixtureText(query);
	let searchTrace;
	const params = new URLSearchParams({
		q: query,
		limit: '1',
	});
	let result;
	for (let attempt = 1; ; attempt++) {
		searchTrace = traces();
		try {
			result = await api('/workspaces/' + user.workspace + '/search?' + params, 200, {
				token: user.token,
				id: searchTrace,
			});
			break;
		} catch (error) {
			if (attempt >= 3 || error?.status !== 503) throw error;
			await delay(61_000);
		}
	}
	const hit = result.items[0];
	check(
		result.embeddingVersion === readVersion &&
			hit?.documentId === documents[0] &&
			hit.matchedBy.includes('semantic'),
		'Voyage semantic search did not rank the expected document first',
	);
	console.log(
		JSON.stringify({
			provider: 'voyage',
			model: 'voyage-4',
			embeddingVersion: readVersion,
			workspaceId: user.workspace,
			documentId: hit.documentId,
			matchedBy: hit.matchedBy,
			indexedDocuments: documents.length,
			versionId: versions[0].versionId,
			status: 'INDEXED',
			indexTrace: await evidence(
				versions[0].id,
				'pipeline_stage_deliveries_total{stage="ACTIVATE",result="completed"}',
				{
					pipeline: true,
					required: ['pipeline.ACTIVATE', 'embedding.document'],
				},
			),
			searchTrace: await evidence(searchTrace, 'hybrid_search_duration_seconds_count', {
				required: ['search.hybrid', 'embedding.query'],
			}),
		}),
	);
}

run()
	.catch((error) => {
		console.error(
			error instanceof CheckFailure ? error.message : 'Live Voyage document search check failed',
		);
		process.exitCode = 1;
	})
	.finally(() => db.$disconnect());
