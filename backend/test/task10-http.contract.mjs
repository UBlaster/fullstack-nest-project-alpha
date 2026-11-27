/* global AbortSignal, URL, URLSearchParams, fetch, process */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

// Prepare three text/plain READY files called task10-contract.txt on an isolated local stack
// with the deterministic embedding provider. Run this script with --fixtures for sample inputs.
// The owner owns home and distractor. Viewer can read those documents. Foreign owner has no
// membership in the home workspace. Each workspace name must begin with "Task 10 contract".
// Run using Node 20+, TASK10_CONTRACT_TESTS=true, TASK10_API_ORIGIN, TASK10_OWNER_TOKEN,
// TASK10_VIEWER_TOKEN, TASK10_FOREIGN_TOKEN, TASK10_HOME_DOC, TASK10_DISTRACTOR_DOC, TASK10_FOREIGN_DOC.
// Optionally set TASK10_REJECTED_FILE_ID to a different READY file of the home document that
// this extractor permanently rejects. Its synthetic contents must differ from the home text.
// Existing READY files remain in place. Only the three designated document versions are requested.
const fileName = 'task10-contract.txt';
const fixtures = {
	home: {
		title: 'Safety handbook',
		text: 'Snapshot restore, backup guide. Edition Home. ' + 'Snapshot restore. '.repeat(35),
	},
	distractor: {
		title: 'Animal shelter',
		text: 'Puppy care, canine guide. Edition Shelter. ' + 'Puppy canine. '.repeat(35),
	},
	foreign: {
		title: 'Saftey handbook',
		text: 'Backup recovery. Edition Foreign. ' + 'Backup recovery. '.repeat(35),
	},
};

function required(name) {
	const value = process.env[name];
	assert.ok(value?.trim(), 'Set ' + name + ' for the dedicated Task 10 fixture');
	return value;
}

function client() {
	const raw = required('TASK10_API_ORIGIN');
	let origin;
	try {
		origin = new URL(raw);
	} catch {
		throw new Error('TASK10_API_ORIGIN must be a loopback origin');
	}
	assert.ok(
		['http:', 'https:'].includes(origin.protocol) &&
			['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) &&
			origin.pathname === '/' &&
			!origin.search &&
			!origin.hash &&
			!origin.username &&
			!origin.password,
		'TASK10_API_ORIGIN must be a loopback origin without credentials or a path',
	);
	return async (label, path, token, statuses, { method = 'GET', body } = {}) => {
		const response = await fetch(new URL(path, origin), {
			method,
			headers: {
				authorization: 'Bearer ' + token,
				...(body && { 'content-type': 'application/json' }),
			},
			body: body && JSON.stringify(body),
			redirect: 'error',
			signal: AbortSignal.timeout(15_000),
		});
		assert.ok(
			statuses.includes(response.status),
			label + ' returned HTTP ' + response.status + ', expected ' + statuses.join(' or '),
		);
		if (response.status < 400) return response.json();
	};
}

async function fixture(api, key, token, docId) {
	assert.match(docId, /^[\w-]+$/, 'Expected a fixture document ID');
	const path = '/documents/' + docId;
	const doc = await api('fixture document', path, token, [200]);
	assert.ok(
		doc?.id === docId && doc.title === fixtures[key].title,
		'Unexpected ' + key + ' fixture document',
	);
	const workspaceId = doc.project?.workspaceId;
	assert.ok(
		typeof workspaceId === 'string' && /^[\w-]+$/.test(workspaceId),
		'Missing fixture workspace',
	);
	const workspacePath = '/workspaces/' + workspaceId;
	const workspace = await api('fixture workspace', workspacePath, token, [200]);
	assert.ok(
		workspace?.name?.startsWith('Task 10 contract'),
		'Expected a dedicated Task 10 contract workspace',
	);
	const files = await api('fixture files', path + '/files', token, [200]);
	const matching = files.filter(
		(file) =>
			file.documentId === docId &&
			file.originalName === fileName &&
			file.status === 'READY' &&
			file.mimeType === 'text/plain',
	);
	assert.equal(matching.length, 1, 'Provide one READY ' + fileName + ' for ' + key);
	return { path, doc, workspacePath, token, fileId: matching[0].id };
}

async function createVersion(api, item) {
	const row = await api('create document version', item.path + '/versions', item.token, [202], {
		method: 'POST',
		body: { sourceFileId: item.fileId },
	});
	assert.ok(
		typeof row?.id === 'string' && /^[\w-]+$/.test(row.id),
		'Expected version ID from create',
	);
	return row.id;
}

async function waitForTerminal(api, token, versionId, expected) {
	const states = [
		'UPLOADED',
		'EXTRACTING',
		'NORMALIZING',
		'CHUNKING',
		'EMBEDDING',
		'INDEXED',
		'FAILED',
	];
	const deadline = Date.now() + 120_000;
	do {
		const row = await api('read version status', '/document-versions/' + versionId, token, [200]);
		assert.ok(
			row.id === versionId && states.includes(row.status),
			'Invalid version identity or status',
		);
		if (row.status === 'INDEXED' || row.status === 'FAILED') {
			assert.ok(
				row.status === expected,
				'Fixture reached ' + row.status + ', expected ' + expected,
			);
			return row;
		}
		await delay(300);
	} while (Date.now() < deadline);
	assert.fail('Timed out waiting for the fixture to reach ' + expected);
}

function items(value) {
	return Array.isArray(value) ? value : value?.items;
}

async function checkSearch(api, item, token, query, channel, key) {
	const params = new URLSearchParams({ q: query, limit: '1' });
	const result = items(
		await api('hybrid search', item.workspacePath + '/search?' + params, token, [200]),
	);
	assert.ok(Array.isArray(result) && result.length === 1, 'Expected one accessible search hit');
	const hit = result[0];
	assert.ok(
		hit.documentId === item.doc.id &&
			hit.projectId === item.doc.projectId &&
			hit.title === item.doc.title,
		'Wrong top-1 workspace result for ' + channel,
	);
	assert.ok(Number.isFinite(Date.parse(hit.updatedAt)), 'Search hit needs an updatedAt timestamp');
	const channels = {
		lexical: /^(lexical|trigram|title)$/i,
		semantic: /^(semantic|vector|embedding)$/i,
	};
	assert.ok(
		Array.isArray(hit.matchedBy) &&
			hit.matchedBy.some((value) => typeof value === 'string' && channels[channel].test(value)),
		'Search hit must explain the ' + channel + ' match',
	);
	assert.ok(
		hit.scores && typeof hit.scores === 'object' && Object.values(hit.scores).some(Number.isFinite),
		'Search hit needs numeric scores',
	);
	assert.ok(
		typeof hit.snippet === 'string' && hit.snippet.trim().length > 0,
		'Expected a nonempty search snippet',
	);
	const publicText = JSON.stringify(hit).replace(/\s+/g, ' ');
	assert.ok(
		!publicText.includes(fixtures[key].text.trim()),
		'Search exposed the complete source text',
	);
	for (const field of ['content', 'body', 'chunks', 'text', 'chunkText', 'embedding', 'vector']) {
		assert.ok(!Object.hasOwn(hit, field), 'Search hit exposes ' + field);
	}
	return hit;
}

if (process.argv.includes('--fixtures')) {
	process.stdout.write(JSON.stringify({ fileName, fixtures }, null, 2) + '\n');
} else {
	test(
		'Task 10 public versioning, permissions and hybrid search',
		{
			skip:
				process.env.TASK10_CONTRACT_TESTS !== 'true' &&
				'Set TASK10_CONTRACT_TESTS=true for the isolated fixture',
		},
		async (t) => {
			const api = client();
			const owner = required('TASK10_OWNER_TOKEN');
			const viewer = required('TASK10_VIEWER_TOKEN');
			const outsider = required('TASK10_FOREIGN_TOKEN');
			assert.ok(
				new Set([owner, viewer, outsider]).size === 3,
				'Use three distinct test identities',
			);
			const [home, distractor, foreign] = await Promise.all([
				fixture(api, 'home', owner, required('TASK10_HOME_DOC')),
				fixture(api, 'distractor', owner, required('TASK10_DISTRACTOR_DOC')),
				fixture(api, 'foreign', outsider, required('TASK10_FOREIGN_DOC')),
			]);
			assert.ok(
				home.workspacePath === distractor.workspacePath &&
					home.workspacePath !== foreign.workspacePath,
				'Expected two isolated fixture workspaces',
			);
			await api('viewer fixture read', home.path, viewer, [200]);
			await api('outsider fixture read', home.path, outsider, [404]);
			await api('owner has no access to foreign fixture', foreign.path, owner, [404]);
			const capabilities = await api(
				'viewer fixture capabilities',
				home.path + '/files/capabilities',
				viewer,
				[200],
			);
			assert.ok(capabilities.canUpdateDocument === false, 'Viewer fixture must be read-only');

			await api('viewer list versions', home.path + '/versions', viewer, [200]);
			await api('outsider list versions', home.path + '/versions', outsider, [404]);
			for (const [token, status] of [
				[viewer, 403],
				[outsider, 404],
			]) {
				await api('denied version creation', home.path + '/versions', token, [status], {
					method: 'POST',
					body: { sourceFileId: home.fileId },
				});
			}

			const rejectedId = process.env.TASK10_REJECTED_FILE_ID;
			if (rejectedId !== undefined) {
				const ready = await api('verify rejected fixture', home.path + '/files', owner, [200]);
				assert.ok(
					rejectedId !== home.fileId &&
						ready.some(
							(file) =>
								file.id === rejectedId &&
								file.documentId === home.doc.id &&
								file.status === 'READY',
						),
					'Provide a second READY file of the home document for the failure case',
				);
			}

			const [homeId, otherId, foreignId] = await Promise.all(
				[home, distractor, foreign].map((item) => createVersion(api, item)),
			);
			await Promise.all(
				[
					[viewer, homeId],
					[owner, otherId],
					[outsider, foreignId],
				].map(([token, id]) => waitForTerminal(api, token, id, 'INDEXED')),
			);
			t.diagnostic('Three READY inputs reached INDEXED through the worker');
			const retryPath = '/document-versions/' + homeId + '/retry';
			await api('outsider version detail', '/document-versions/' + homeId, outsider, [404]);
			await api('viewer retry', retryPath, viewer, [403], { method: 'POST' });
			await api('outsider retry', retryPath, outsider, [404], { method: 'POST' });
			const readVersionIds = async () => {
				const rows = items(
					await api('viewer version list', home.path + '/versions', viewer, [200]),
				);
				assert.ok(Array.isArray(rows), 'Expected a list of versions');
				return rows.map((row) => row.id).sort();
			};
			const before = await readVersionIds();
			assert.ok(before.filter((id) => id === homeId).length === 1, 'Expected one indexed version');
			const repeat = await api(
				'duplicate version request',
				home.path + '/versions',
				owner,
				[200, 202],
				{ method: 'POST', body: { sourceFileId: home.fileId } },
			);
			assert.ok(repeat.id === homeId, 'The same READY file created a different version');
			assert.deepEqual(
				await readVersionIds(),
				before,
				'The repeated input changed the version list',
			);

			await api(
				'outsider workspace search',
				home.workspacePath + '/search?q=backup&limit=1',
				outsider,
				[404],
			);
			await checkSearch(api, home, viewer, 'Saftey handbook', 'lexical', 'home');
			const initial = await checkSearch(api, home, viewer, 'backup recovery', 'semantic', 'home');
			await checkSearch(api, distractor, viewer, 'puppy care', 'semantic', 'distractor');
			await checkSearch(api, foreign, outsider, 'Saftey handbook', 'lexical', 'foreign');
			t.diagnostic(
				'Repeated input, viewer/outsider boundaries, typo and body-based retrieval passed',
			);

			await t.test(
				'failed replacement leaves the previous indexed version searchable',
				{
					skip:
						rejectedId === undefined &&
						'Supply TASK10_REJECTED_FILE_ID for the extraction-failure case',
				},
				async () => {
					const failedId = await createVersion(api, { ...home, fileId: rejectedId });
					assert.ok(failedId !== homeId, 'Different fixture contents need distinct versions');
					const failed = await waitForTerminal(api, viewer, failedId, 'FAILED');
					const previous = await api(
						'previous version after extraction failure',
						'/document-versions/' + homeId,
						viewer,
						[200],
					);
					assert.ok(
						previous.id === homeId && previous.status === 'INDEXED',
						'The previous version lost its index',
					);
					if ('isCurrent' in previous)
						assert.ok(previous.isCurrent === true, 'The previous version lost current status');
					if ('isCurrent' in failed)
						assert.ok(failed.isCurrent === false, 'Failed version became current');
					const retained = await checkSearch(
						api,
						home,
						viewer,
						'backup recovery',
						'semantic',
						'home',
					);
					assert.ok(
						retained.snippet === initial.snippet ||
							/\b(snapshot|restore)\b/i.test(retained.snippet),
						'Search lost the previous version passage',
					);
				},
			);
		},
	);
}
