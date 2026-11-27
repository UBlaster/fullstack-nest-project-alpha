/* global Buffer, URLSearchParams, console, performance, process */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';
import {
	api,
	db,
	document,
	headers,
	indexed,
	owner,
	state,
	traces,
	upload,
	version,
} from './task10-api-fixtures.mjs';
import amqp from 'amqplib';
import {
	CheckFailure,
	check,
	until,
	evidence,
	waitLog,
	safe,
	isTestEnvironment,
} from './task10-telemetry.mjs';

const queue = 'task10-pipeline-stages';
const metric = 'pipeline_stage_deliveries_total';
const privateMarker = 'T10_PRIVATE_' + randomUUID();
// One-page ASCII PDF with a valid cross-reference table for the worker's Poppler extractor.
function pdfFixture(text) {
	const stream = 'BT /F1 12 Tf 72 720 Td (' + text + ') Tj ET';
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
		'<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream',
	];
	let pdf = '%PDF-1.4\n';
	const offsets = ['0000000000 65535 f '];
	objects.forEach((object, i) => {
		offsets.push(String(pdf.length).padStart(10, '0') + ' 00000 n ');
		pdf += i + 1 + ' 0 obj\n' + object + '\nendobj\n';
	});
	const xref = pdf.length;
	return (
		pdf +
		'xref\n0 6\n' +
		offsets.join('\n') +
		'\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' +
		xref +
		'\n%%EOF\n'
	);
}
async function search(user, q, doc, match, marker, expectedVersion = 'v1', id = traces()) {
	const started = performance.now();
	const r = await api(
		'/workspaces/' + user.workspace + '/search?' + new URLSearchParams({ q, limit: '1' }),
		200,
		{ token: user.token, id },
	);
	const hit = r.items[0];
	check(
		r.items.length === 1 && hit?.documentId === doc && hit.matchedBy.includes(match),
		'Wrong top-1 ' + match + ' result',
	);
	check(hit.snippet.includes(marker), 'Search snippet came from the wrong version');
	check(r.embeddingVersion === expectedVersion && hit.scores.rrf > 0, 'Wrong RRF or read version');
	return {
		documentId: hit.documentId,
		matchedBy: hit.matchedBy,
		rrf: hit.scores.rrf,
		embeddingVersion: r.embeddingVersion,
		latencyMs: Math.round(performance.now() - started),
	};
}
function rollout(action, v, shouldFail = false) {
	try {
		const out = execFileSync(process.execPath, ['dist/src/embeddings/rollout.js', action, v], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 90000,
		});
		check(!shouldFail, 'Rollout allowed early switch');
		return JSON.parse(out.trim().split(/\r?\n/).at(-1));
	} catch (error) {
		if (shouldFail && error.status === 1) return;
		if (error instanceof CheckFailure) throw error;
		throw new CheckFailure('Rollout failed: ' + action + ' ' + v);
	}
}
function report(scenario, data) {
	console.log(JSON.stringify({ scenario, ...data }));
}

async function run() {
	check(
		isTestEnvironment(process.env),
		'Dedicated Task 10 database and queues in nest-fullstack-project are required',
	);
	const [currentDb] = await db.$queryRawUnsafe('SELECT current_database() AS name');
	check(currentDb.name === 'task10_pipeline_test', 'Unexpected database');
	const broker = await amqp.connect(process.env.RABBITMQ_URL, { timeout: 10000 });
	broker.on('error', () => {});
	const ch = await broker.createConfirmChannel();
	ch.on('error', () => {});
	const lines = createInterface({ input: process.stdin });
	const replies = lines[Symbol.asyncIterator]();
	async function control(action) {
		console.log('::worker.' + action);
		let timer;
		try {
			const reply = await Promise.race([
				replies.next(),
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new CheckFailure('Timed out controlling worker')), 75000);
				}),
			]);
			check(reply.value === 'ok', 'No acknowledgement from test controller');
		} finally {
			clearTimeout(timer);
		}
	}
	async function receive(name) {
		return until(() => ch.get(name, { noAck: false }), 'AMQP delivery from ' + name);
	}
	async function inject(job, id) {
		ch.sendToQueue(queue, Buffer.from(JSON.stringify(job)), {
			persistent: true,
			contentType: 'application/json',
			messageId: randomUUID(),
			headers: headers(id),
		});
		await ch.waitForConfirms();
	}
	const inspection = [];
	const inspect = (scenario, id, selector, opts = {}) =>
		inspection.push({ scenario, id, selector, opts });
	let resetModel = false;
	try {
		// An exclusive test queue serializes model switches and worker restarts. RabbitMQ
		// releases it on disconnect, including abrupt termination of the runner.
		try {
			await ch.assertQueue(queue + '-acceptance-lock', {
				exclusive: true,
				durable: false,
				autoDelete: true,
			});
		} catch {
			throw new CheckFailure('Cannot reserve the Task 10 check on the shared broker');
		}
		// A previous interrupted run may have stopped between switch and rollback.
		const config = rollout('coverage', 'v1');
		if (config.embeddingVersion !== 'v1') rollout('switch', 'v1');
		if (config.writeVersions.includes('v2')) rollout('retire', 'v2');
		const home = await owner(),
			other = await owner();
		const doc = await document(home, 'Safety handbook');
		const foreign = await document(other, 'Saftey handbook');
		const unrelated = await document(home, 'Animal shelter');
		const firstFile = await upload(
			home,
			doc,
			'snapshot restore files. FirstEdition ' + privateMarker,
		);
		const first = await version(home, doc, firstFile);
		const active = await indexed(home, first);
		await api('/documents/' + doc + '/files/' + firstFile, 409, {
			token: home.token,
			method: 'DELETE',
		});
		check(
			active.stages.length === 6 &&
				active.stages.every((s) => s.status === 'COMPLETED' && s.attempts === 1),
			'Initial stages incomplete',
		);
		check(
			(await version(home, doc, firstFile)).versionId === first.versionId,
			'Duplicate ingest created a new version',
		);
		const foreignV = await version(other, foreign, await upload(other, foreign, 'backup recovery'));
		await indexed(other, foreignV);
		await search(other, 'Saftey handbook', foreign, 'lexical', 'backup');
		await search(other, 'backup recovery', foreign, 'semantic', 'backup');
		// Both positions of the ANN shortlist (2 * limit) would be taken by stronger foreign hits.
		const foreignTwin = await document(other, 'Saftey handbook');
		await indexed(
			other,
			await version(other, foreignTwin, await upload(other, foreignTwin, 'backup recovery')),
		);
		const spareFile = await upload(
			home,
			unrelated,
			'canine puppy dog. Distractor ' + privateMarker,
		);
		const spare = await version(home, unrelated, spareFile);
		await indexed(home, spare);
		const lexId = traces(),
			semId = traces();
		const lexical = await search(
			home,
			'Saftey handbook',
			doc,
			'lexical',
			'FirstEdition',
			'v1',
			lexId,
		);
		const semantic = await search(
			home,
			'backup recovery',
			doc,
			'semantic',
			'FirstEdition',
			'v1',
			semId,
		);
		report('upload-index-search', {
			workspaceId: home.workspace,
			documentId: doc,
			versionId: first.versionId,
			status: active.status,
			current: active.isCurrent,
			lexical,
			semantic,
			foreignWorkspace: other.workspace,
		});
		inspect('upload-index-search', first.id, metric + '{stage="ACTIVATE",result="completed"}', {
			pipeline: true,
			required: ['pipeline.ACTIVATE', 'embedding.document'],
		});
		inspect('workspace-lexical-limit-1', lexId, 'hybrid_search_duration_seconds_count');
		inspect('workspace-semantic-limit-1', semId, 'hybrid_search_duration_seconds_count', {
			requireVectorShortlist: true,
		});
		const denied = traces();
		const deniedPaths = [
			['/workspaces/' + home.workspace + '/search?q=backup', {}],
			['/documents/' + doc + '/versions', {}],
			['/document-versions/' + first.versionId, {}],
			['/document-versions/' + first.versionId + '/retry', { method: 'POST' }],
			['/documents/' + doc + '/versions', { body: { sourceFileId: firstFile } }],
		];
		for (const [i, [path, options]] of deniedPaths.entries())
			await api(path, 404, { token: other.token, id: i === 0 ? denied : traces(), ...options });
		report('outsider', { status: 404, endpoints: deniedPaths.length });
		inspect('outsider', denied, 'workspace_http_requests_total{status_class="4xx"}');

		const hash = (
			await db.documentVersion.findUniqueOrThrow({
				where: { id: first.versionId },
				select: { contentHash: true },
			})
		).contentHash;
		const snapshot = () =>
			Promise.all([
				db.pipelineStageRun.findMany({
					where: { versionId: first.versionId },
					orderBy: { stage: 'asc' },
					select: { id: true, attempts: true, updatedAt: true },
				}),
				db.documentChunk.findMany({
					where: { versionId: first.versionId },
					orderBy: { id: 'asc' },
					select: { id: true, embeddings: { select: { id: true }, orderBy: { id: 'asc' } } },
				}),
				db.outboxEvent.findMany({
					where: {
						type: 'PIPELINE_STAGE',
						payload: { path: ['documentVersionId'], equals: first.versionId },
					},
					orderBy: { id: 'asc' },
					select: { id: true },
				}),
			]);
		const before = await snapshot();
		const duplicate = traces();
		await inject(
			{ documentVersionId: first.versionId, stage: 'EMBED', inputHash: hash },
			duplicate,
		);
		await waitLog(duplicate, (e) => e.operation === 'pipeline.stage' && e.result === 'duplicate');
		check(
			JSON.stringify(before) === JSON.stringify(await snapshot()),
			'Duplicate stage repeated effects',
		);
		report('duplicate', {
			versionId: first.versionId,
			stage: 'EMBED',
			attempts: 1,
			unchangedRuns: before[0].length,
			unchangedChunks: before[1].length,
			unchangedDispatches: before[2].length,
		});
		inspect('duplicate', duplicate, metric + '{result="duplicate"}', {
			logOperation: 'pipeline.stage',
			forbidden: ['embedding.document', 's3.GetObject'],
		});

		const secondFile = await upload(
			home,
			doc,
			'vehicle car automobile. SecondEdition ' + privateMarker,
		);
		const recoveredDoc = await document(home, 'Worker restart fixture');
		const recoveryFile = await upload(
			home,
			recoveredDoc,
			pdfFixture('orchard harvest. RestoredCheckpoint ' + privateMarker),
			'application/pdf',
		);
		const revokedFile = await upload(other, foreign, 'membership fixture ' + privateMarker);
		await control('stop');
		const second = await version(home, doc, secondFile);
		const held = await receive(queue);
		const original = JSON.parse(held.content.toString());
		check(
			original.documentVersionId === second.versionId && original.stage === 'EXTRACT',
			'Unexpected delivery',
		);
		const recovered = await version(home, recoveredDoc, recoveryFile);
		const crashed = await receive(queue);
		check(
			JSON.parse(crashed.content.toString()).documentVersionId === recovered.versionId,
			'Unexpected recovery fixture',
		);
		const stale = await db.pipelineStageRun.updateMany({
			where: { versionId: recovered.versionId, stage: 'EXTRACT' },
			data: {
				status: 'RUNNING',
				attempts: 1,
				claimToken: randomUUID(),
				heartbeatAt: new Date(Date.now() - 120000),
			},
		});
		check(stale.count === 1, 'Expected pending EXTRACT row');
		const author = await db.workspaceMember.findFirstOrThrow({
			where: { workspaceId: home.workspace, role: 'OWNER' },
		});
		const grant = await db.workspaceMember.create({
			data: { userId: author.userId, workspaceId: other.workspace, role: 'MEMBER' },
		});
		let revoked;
		try {
			revoked = await version(home, foreign, revokedFile);
		} finally {
			await db.workspaceMember.delete({ where: { id: grant.id } });
		}
		const originalKey = (await db.documentFile.findUniqueOrThrow({ where: { id: secondFile } }))
			.objectKey;
		// Simulate an unavailable source for this one fixture without deleting the uploaded object.
		await db.documentFile.update({
			where: { id: secondFile },
			data: { objectKey: originalKey + '-missing' },
		});
		try {
			await control('start');
			const deniedRun = await until(async () => {
				const row = await state(other, revoked);
				return row.status === 'FAILED' && row;
			}, 'worker membership recheck');
			check(
				deniedRun.stages[0].errorCode === 'MEMBERSHIP_REVOKED' &&
					deniedRun.stages[0].attempts === 1,
				'Worker retained revoked access',
			);
			report('revoked-membership', {
				versionId: revoked.versionId,
				status: deniedRun.status,
				errorCode: deniedRun.stages[0].errorCode,
			});
			inspect('revoked-membership', revoked.id, metric + '{result="dead"}', {
				pipeline: true,
				required: ['pipeline.EXTRACT'],
			});
			const early = traces();
			await inject({ ...original, stage: 'INDEX' }, early);
			await waitLog(early, (e) => e.operation === 'pipeline.stage' && e.result === 'out_of_order');
			const pending = await state(home, second);
			check(
				!pending.isCurrent && !pending.stages.some((s) => s.stage === 'INDEX' && s.attempts > 0),
				'Premature INDEX ran',
			);
			const pendingHit = await search(home, 'backup recovery', doc, 'semantic', 'FirstEdition');
			report('out-of-order', {
				versionId: second.versionId,
				status: pending.status,
				previousCurrent: first.versionId,
				search: pendingHit,
			});
			inspect('out-of-order', early, metric + '{result="out_of_order"}', {
				logOperation: 'pipeline.stage',
			});
			ch.nack(held, false, true);
			const processing = await until(async () => {
				const row = await state(home, second);
				return row.status === 'EXTRACTING' && !row.isCurrent && row;
			}, 'second version processing');
			const during = traces();
			report('previous-active-during-processing', {
				status: processing.status,
				current: first.versionId,
				search: await search(
					home,
					'backup recovery',
					doc,
					'semantic',
					'FirstEdition',
					'v1',
					during,
				),
			});
			inspect('previous-active-during-processing', during, 'hybrid_search_duration_seconds_count');
			const failed = await until(
				async () => {
					const row = await state(home, second);
					return row.status === 'FAILED' && row;
				},
				'five delayed retries',
				140000,
			);
			check(
				failed.stages.find((s) => s.stage === 'EXTRACT')?.attempts === 6,
				'Expected initial attempt and five retries',
			);
			const deadName = queue + '-dead';
			// Older failed runs can have their own dead letters. Preserve those messages.
			let dead;
			const others = [];
			try {
				for (;;) {
					dead = await receive(deadName);
					if (JSON.parse(dead.content.toString()).documentVersionId === second.versionId) break;
					others.push(dead);
				}
				const payload = JSON.parse(dead.content.toString());
				check(
					Object.keys(payload).sort().join(',') === 'documentVersionId,errorCode,stage',
					'Unsafe DLQ schema',
				);
				safe(dead.content.toString());
				check(
					payload.stage === 'EXTRACT' && payload.errorCode === 'RETRIES_EXHAUSTED',
					'Wrong DLQ outcome',
				);
				ch.ack(dead);
			} finally {
				for (const m of others) ch.nack(m, false, true);
			}
			const stillCurrent = await search(home, 'backup recovery', doc, 'semantic', 'FirstEdition');
			report('retry-exhaustion', {
				versionId: second.versionId,
				status: failed.status,
				attempts: 6,
				dlq: deadName,
				previousCurrent: first.versionId,
				search: stillCurrent,
			});
			inspect('retry-exhaustion', second.id, metric + '{result="dead"}', {
				pipeline: true,
				required: ['pipeline.EXTRACT'],
			});
		} finally {
			await db.documentFile.update({ where: { id: secondFile }, data: { objectKey: originalKey } });
		}
		const retry = traces();
		await api('/document-versions/' + second.versionId + '/retry', 202, {
			token: home.token,
			method: 'POST',
			id: retry,
		});
		const next = await indexed(home, second);
		check(!(await state(home, first)).isCurrent, 'Old version still current');
		const replaced = await search(home, 'automobile', doc, 'semantic', 'SecondEdition');
		report('manual-retry', {
			versionId: second.versionId,
			status: next.status,
			current: next.isCurrent,
			search: replaced,
		});
		inspect('manual-retry', retry, metric + '{stage="ACTIVATE",result="completed"}', {
			pipeline: true,
			required: ['pipeline.ACTIVATE'],
		});
		const recoveredState = await indexed(home, recovered);
		check(
			recoveredState.stages.find((s) => s.stage === 'EXTRACT')?.attempts === 2,
			'Abandoned EXTRACT was not recovered',
		);
		ch.nack(crashed, false, true);
		report('heartbeat-recovery', {
			versionId: recovered.versionId,
			status: recoveredState.status,
			current: recoveredState.isCurrent,
			attempts: 2,
		});
		// Recovery starts from a persisted checkpoint. The recovered publish keeps its own correlation.
		const recoveryEvent = await db.outboxEvent.findFirst({
			where: {
				type: 'PIPELINE_STAGE',
				payload: { path: ['documentVersionId'], equals: recovered.versionId },
			},
			orderBy: { createdAt: 'desc' },
		});
		const recoveryTrace = recoveryEvent?.payload?.carrier?.traceparent?.split('-')[1];
		check(recoveryTrace, 'Missing recovery trace context');
		inspect('heartbeat-recovery', recoveryTrace, 'pipeline_stage_recoveries_total', {
			logOperation: 'pipeline.recover',
			required: ['pipeline.recover', 'pipeline.ACTIVATE'],
		});

		resetModel = true;
		rollout('dual-write', 'v2');
		const gap = rollout('coverage', 'v2');
		check(gap.total > gap.ready, 'Expected a backfill gap');
		rollout('switch', 'v2', true);
		const dualDoc = await document(home, 'Dual write fixture');
		const dual = await version(
			home,
			dualDoc,
			await upload(home, dualDoc, 'tulip bulb. DualWrite ' + privateMarker),
		);
		await indexed(home, dual);
		const dualRows = await db.$queryRawUnsafe(
			'SELECT DISTINCT e."embeddingVersion" FROM "DocumentEmbedding" e JOIN "DocumentChunk" c ON c.id=e."chunkId" WHERE c."versionId"=$1 ORDER BY 1',
			dual.versionId,
		);
		check(
			dualRows.map((x) => x.embeddingVersion).join(',') === 'v1,v2',
			'New chunk missing dual write',
		);
		const filled = rollout('backfill', 'v2');
		check(
			filled.written > 0 &&
				filled.ready === filled.total &&
				rollout('backfill', 'v2').written === 0,
			'Backfill coverage or checkpoint failed',
		);
		rollout('switch', 'v2');
		const switchTrace = traces();
		const switched = await search(
			home,
			'automobile',
			doc,
			'semantic',
			'SecondEdition',
			'v2',
			switchTrace,
		);
		rollout('switch', 'v1');
		const rollbackTrace = traces();
		const rollback = await search(
			home,
			'automobile',
			doc,
			'semantic',
			'SecondEdition',
			'v1',
			rollbackTrace,
		);
		rollout('retire', 'v2');
		check(
			rollout('cleanup', 'v2').deleted > 0 && rollout('cleanup', 'v2').deleted === 0,
			'Cleanup was not repeatable',
		);
		resetModel = false;
		report('model-rollout', {
			dualWrite: dualRows.length,
			before: gap.ready,
			totalBefore: gap.total,
			backfilled: filled.written,
			coverage: [filled.ready, filled.total],
			switched,
			rollback,
		});
		inspect('dual-write', dual.id, metric + '{stage="EMBED",result="completed"}', {
			pipeline: true,
			required: ['pipeline.EMBED'],
		});
		inspect('read-switch', switchTrace, 'hybrid_search_duration_seconds_count');
		inspect('rollback', rollbackTrace, 'hybrid_search_duration_seconds_count');
		for (const { scenario, id, selector, opts } of inspection)
			report(scenario + '-evidence', { traceId: id, ...(await evidence(id, selector, opts)) });
		console.log(
			'PASS Task 10 — Yandex Object Storage, PostgreSQL/pgvector, RabbitMQ, deterministic fake embeddings',
		);
	} finally {
		lines.close();
		try {
			if (resetModel) {
				const config = rollout('coverage', 'v1');
				if (config.embeddingVersion !== 'v1') rollout('switch', 'v1');
				if (config.writeVersions.includes('v2')) rollout('retire', 'v2');
			}
		} finally {
			await ch.close().catch(() => {});
			await broker.close().catch(() => {});
		}
	}
}
run()
	.catch((error) => {
		console.error(
			error instanceof CheckFailure
				? error.message
				: 'Unexpected Task 10 check failure (' + error.name + ').',
		);
		process.exitCode = 1;
	})
	.finally(() => db.$disconnect());
