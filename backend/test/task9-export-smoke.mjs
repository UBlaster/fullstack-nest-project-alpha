/* global AbortSignal, console, fetch, process, URL */
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';

const yandex = 'https://storage.yandexcloud.net';
const active = new Set(['QUEUED', 'PROCESSING']);
const attemptFile = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.csv$/i;
class SmokeFailure extends Error {}

function validateYandex() {
	const env = process.env;
	if (
		env.TASK9_ENABLE_YANDEX_EXPORT !== 'true' ||
		[env.S3_BUCKET, env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY].some(
			(v) => !v || v === 'task9-not-configured',
		)
	) {
		throw new SmokeFailure('Dedicated Yandex test bucket and credentials are required');
	}
	if (
		env.S3_ENDPOINT !== yandex ||
		env.S3_REGION !== 'ru-central1' ||
		env.S3_FORCE_PATH_STYLE !== 'true'
	)
		throw new SmokeFailure('Expected path-style Yandex HTTPS endpoint in ru-central1');
}

function ownedKey(row, workspaceId) {
	const prefix = `workspaces/${workspaceId}/exports/${row.id}/`;
	if (!row.objectKey?.startsWith(prefix) || !attemptFile.test(row.objectKey.slice(prefix.length))) {
		throw new SmokeFailure('Unexpected export object key');
	}
	return row.objectKey;
}

async function removeFixtureObject(key) {
	const {
		S3_ACCESS_KEY_ID: accessKeyId,
		S3_SECRET_ACCESS_KEY: secretAccessKey,
		S3_BUCKET: Bucket,
	} = process.env;
	const s3 = new S3Client({
		endpoint: yandex,
		region: 'ru-central1',
		forcePathStyle: true,
		credentials: { accessKeyId, secretAccessKey },
		maxAttempts: 2,
	});
	const object = { Bucket, Key: key };
	try {
		// In a versioned bucket remove the precise fixture version. A plain DELETE
		// would create a delete marker while leaving the uploaded bytes behind.
		const versions = new Set();
		for (;;) {
			let head;
			try {
				head = await s3.send(new HeadObjectCommand(object), {
					abortSignal: AbortSignal.timeout(8000),
				});
			} catch (error) {
				if (error?.$metadata?.httpStatusCode === 404) return;
				throw error;
			}
			if (versions.has(head.VersionId))
				throw new SmokeFailure('Fixture object removal could not be verified');
			versions.add(head.VersionId);
			await s3.send(new DeleteObjectCommand({ ...object, VersionId: head.VersionId }), {
				abortSignal: AbortSignal.timeout(8000),
			});
		}
	} finally {
		s3.destroy();
	}
}

async function cleanupExport(prisma, request, workspaceId, jobId) {
	// The randomly created workspace belongs solely to this run. Recover the job
	// from it even if the enqueue response was lost after the outbox commit.
	const find = () =>
		prisma.exportJob.findFirst({
			where: { workspaceId, ...(jobId && { id: jobId }) },
			select: { id: true, status: true, objectKey: true },
		});
	let row = await find();
	if (!row) throw new SmokeFailure('Fixture cleanup could not establish the export state');
	if (active.has(row.status)) {
		await request(`/exports/${row.id}`, 202, { method: 'DELETE' });
		const deadline = Date.now() + 20_000;
		do {
			row = await find();
			if (row && !active.has(row.status)) break;
			await delay(300);
		} while (Date.now() < deadline);
	}
	if (!row || active.has(row.status))
		throw new SmokeFailure('Export cancellation is pending; fixture metadata retained');
	if (!row.objectKey) return;
	const key = ownedKey(row, workspaceId);
	await removeFixtureObject(key);
	await prisma.exportJob.updateMany({
		where: { id: row.id, workspaceId, status: row.status, objectKey: key },
		data: { objectKey: null, expiredAt: new Date() },
	});
}

// Run inside the API container in observability/compose.test.yml.
async function smoke() {
	const db = new URL(process.env.DATABASE_URL ?? 'about:blank');
	if (db.hostname !== 'postgres' || db.pathname !== '/task9_observability_test') {
		throw new SmokeFailure('Expected the isolated Task 9 API container');
	}
	const args = process.argv.slice(2);
	if (args.length && (args.length !== 1 || args[0] !== '--export'))
		throw new SmokeFailure('Unknown smoke argument');
	const exportRequested = args.length === 1;
	if (exportRequested) validateYandex();
	const run = randomUUID();
	const exportRequestId = `tt9-export-${run}`;
	const traceId = randomBytes(16).toString('hex');
	const email = `tt9-${run}@example.test`;
	const password = `OBS9_PRIVATE_${randomUUID()}`;
	const marker = `OBS9_PRIVATE_${run}`;
	let token;

	async function request(path, status, { body, headers = {}, method } = {}) {
		const response = await fetch('http://127.0.0.1:3000' + path, {
			method: method ?? (body ? 'POST' : 'GET'),
			headers: {
				'content-type': 'application/json',
				'x-request-id': `tt9-${randomUUID()}`,
				...(token && { authorization: `Bearer ${token}` }),
				...headers,
			},
			body: body && JSON.stringify(body),
			signal: AbortSignal.timeout(15_000),
		});
		if (response.status !== status) {
			throw new SmokeFailure(`API returned ${response.status}, expected ${status}`);
		}
		return response;
	}

	await request('/auth/register', 201, {
		body: { name: marker, email, password, passwordConfirmation: password },
	});
	const login = await request('/auth/login', 200, { body: { email, password } });
	token = (await login.json()).accessToken;
	const workspace = await request('/workspaces', 201, { body: { name: marker } });
	const workspaceId = (await workspace.json()).id;
	const projects = `/workspaces/${workspaceId}/projects`;
	const project = await request(projects, 201, { body: { name: marker } });
	const projectId = (await project.json()).id;
	await request(`/projects/${projectId}/documents`, 201, {
		body: { title: marker, content: marker },
	});
	await request(projects, 200);
	await request(projects, 200);
	const failures = [];
	for (const [step, path, status, options] of [
		['missing', `/missing/${marker}?probe=${marker}`, 404, { headers: { cookie: marker } }],
		[
			'unconfigured',
			`/workspaces/${workspaceId}/payments`,
			503,
			{
				body: { purpose: 'WORKSPACE_DEMO' },
				headers: { 'Idempotency-Key': randomUUID() },
			},
		],
	]) {
		const errorTrace = randomBytes(16).toString('hex');
		const requestId = `tt9-${step}-${run}`;
		const error = await request(path, status, {
			...options,
			headers: {
				...options.headers,
				'x-request-id': requestId,
				traceparent: `00-${errorTrace}-${randomBytes(8).toString('hex')}-01`,
			},
		});
		const publicBody = await error.text();
		if (!publicBody.includes(requestId) || publicBody.includes(marker))
			throw new SmokeFailure('Unsafe error response');
		failures.push({ step, requestId, traceId: errorTrace });
	}
	if (!exportRequested) return { failures };
	const prisma = new PrismaClient();
	let jobId;
	try {
		const queued = await request(`/workspaces/${workspaceId}/exports`, 202, {
			body: {},
			headers: {
				'x-request-id': exportRequestId,
				traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01`,
			},
		});
		jobId = (await queued.json()).id;
		if (queued.headers.get('x-request-id') !== exportRequestId)
			throw new SmokeFailure('Request ID changed');
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			const response = await request(`/exports/${jobId}`, 200);
			const job = await response.json();
			if (job.status === 'COMPLETED') {
				const row = await prisma.exportJob.findFirstOrThrow({
					where: { id: jobId, workspaceId },
					select: { id: true, objectKey: true },
				});
				const key = ownedKey(row, workspaceId);
				const url = new URL(job.downloadUrl);
				if (
					url.origin !== yandex ||
					url.username ||
					url.password ||
					url.pathname !== `/${process.env.S3_BUCKET}/${key}` ||
					!url.searchParams.has('X-Amz-Signature')
				) {
					throw new SmokeFailure('Unexpected signed download target');
				}
				const download = await fetch(url, {
					signal: AbortSignal.timeout(5000),
					redirect: 'error',
				});
				if (!download.ok || !(await download.text()).includes(marker))
					throw new SmokeFailure('CSV verification failed');
				return {
					requestId: exportRequestId,
					traceId,
					jobId,
					status: job.status,
					csvVerified: true,
					failures,
				};
			}
			if (!active.has(job.status)) throw new SmokeFailure('Export terminated early');
			await delay(500);
		}
		throw new SmokeFailure('Export did not complete within 90 seconds');
	} finally {
		try {
			await cleanupExport(prisma, request, workspaceId, jobId);
		} catch (error) {
			if (error instanceof SmokeFailure) throw error;
			throw new SmokeFailure('Export cleanup failed; fixture metadata retained');
		} finally {
			await prisma.$disconnect();
		}
	}
}

smoke()
	.then((result) => console.log(JSON.stringify(result)))
	.catch((error) => {
		// SDK and transport errors may contain signed URLs or request details.
		console.error(error instanceof SmokeFailure ? error.message : 'Task 9 smoke failed');
		process.exitCode = 1;
	});
