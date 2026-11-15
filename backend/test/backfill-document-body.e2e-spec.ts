import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import {
	BackfillContract,
	BackfillHooks,
	BackfillLogEntry,
	BackfillOptions,
	loadBackfillContract,
} from './backfill-document-body-contract';
import {
	createLegacyDocument,
	readLegacyDocument,
	readLegacyDocumentsByProject,
	updateLegacyDocument,
} from './document-legacy-sql';

const describeBackfill = process.env.TASK7_BACKFILL_E2E === 'true' ? describe : describe.skip;

function dedicatedDatabaseUrl(): string {
	const value = process.env.TASK7_BACKFILL_DATABASE_URL;
	if (!value) throw new Error('TASK7_BACKFILL_DATABASE_URL is required for this opt-in suite');
	let target: URL;
	try {
		target = new URL(value);
	} catch {
		throw new Error('Invalid backfill test database configuration');
	}
	if (
		!['postgres:', 'postgresql:'].includes(target.protocol) ||
		!['localhost', '127.0.0.1'].includes(target.hostname) ||
		target.port !== '55437' ||
		target.pathname !== '/task7_backfill_test' ||
		(target.searchParams.get('schema') ?? 'public') !== 'public' ||
		target.searchParams.getAll('schema').length > 1 ||
		[...target.searchParams.keys()].some((key) => key !== 'schema')
	) {
		throw new Error('Only the dedicated local task7_backfill_test database is allowed');
	}
	return value;
}

function gate() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describeBackfill('Document body backfill against isolated PostgreSQL', () => {
	const runId = `task7-backfill-${randomUUID()}`;
	const ownerId = `${runId}-owner`;
	const workspaceId = `${runId}-workspace`;
	const projectId = `${runId}-project`;
	let prisma: PrismaClient;
	let writer: PrismaClient;
	let observer: PrismaClient;
	let readCounts: BackfillContract['readCounts'];
	let runBackfill: BackfillContract['runBackfill'];
	let databaseVerified = false;
	const id = (suffix: string) => `${runId}-${suffix}`;
	const options = (overrides: Partial<BackfillOptions> = {}): BackfillOptions => ({
		dryRun: false,
		mode: 'missing',
		batchSize: 2,
		maxBatches: 20,
		...overrides,
	});
	const run = (overrides: Partial<BackfillOptions> = {}, hooks: BackfillHooks = {}) =>
		runBackfill(prisma, options(overrides), {
			logger: () => undefined,
			pause: async () => undefined,
			...hooks,
		});
	const create = (suffix: string, content: string, body: string | null = null) =>
		createLegacyDocument(prisma, {
			id: id(suffix),
			projectId,
			authorId: ownerId,
			title: 'Fixture',
			content,
			body,
		});
	const row = (suffix: string) => readLegacyDocument(prisma, id(suffix));
	const snapshot = () => readLegacyDocumentsByProject(prisma, projectId);
	const batchEntries = (entries: BackfillLogEntry[]) =>
		entries.filter((entry) => entry.event === 'batch');

	beforeAll(async () => {
		({ readCounts, runBackfill } = await loadBackfillContract());
		const url = dedicatedDatabaseUrl();
		prisma = new PrismaClient({ datasources: { db: { url } } });
		writer = new PrismaClient({ datasources: { db: { url } } });
		observer = new PrismaClient({ datasources: { db: { url } } });
		await Promise.all([prisma.$connect(), writer.$connect(), observer.$connect()]);
		const [target] = await prisma.$queryRaw<Array<{ database: string; schema: string }>>`
			SELECT current_database() AS database, current_schema() AS schema
		`;
		if (target.database !== 'task7_backfill_test' || target.schema !== 'public') {
			throw new Error('Backfill test database identity did not match its isolated target');
		}
		// CLI меняет всю таблицу: чужие документы нельзя даже временно включать в этот запуск.
		if ((await prisma.document.count()) !== 0) {
			throw new Error('The dedicated backfill database must start without documents');
		}
		databaseVerified = true;
		await prisma.user.create({
			data: {
				id: ownerId,
				email: `${runId}@example.test`,
				name: 'Backfill fixture owner',
				password: 'fixture-without-password-login',
			},
		});
		await prisma.workspace.create({
			data: {
				id: workspaceId,
				name: 'Backfill test workspace',
				projects: { create: { id: projectId, name: 'Backfill fixtures', createdById: ownerId } },
			},
		});
	});

	beforeEach(async () => {
		if ((await prisma.document.count()) !== 0) {
			throw new Error('Unexpected documents remain before the next isolated backfill test');
		}
	});

	afterEach(async () => {
		if (databaseVerified) await prisma.document.deleteMany({ where: { projectId } });
	});

	afterAll(async () => {
		try {
			if (databaseVerified) {
				await prisma.workspace.deleteMany({ where: { id: workspaceId } });
				await prisma.user.deleteMany({ where: { id: ownerId } });
			}
		} finally {
			await Promise.all([prisma?.$disconnect(), writer?.$disconnect(), observer?.$disconnect()]);
		}
	});

	it.each(['missing', 'reconcile'] as const)(
		'dry-run %s reports the full table without writes',
		async (mode) => {
			await create('10', 'Missing text');
			await create('20', 'Current legacy text', 'Stale body');
			await create('30', 'Equal text', 'Equal text');
			const before = await snapshot();
			const entries: BackfillLogEntry[] = [];
			const pause = jest.fn().mockResolvedValue(undefined);
			const result = await run(
				{ mode, dryRun: true, batchSize: 1, maxBatches: 1 },
				{
					logger: (entry) => {
						entries.push(entry);
					},
					pause,
				},
			);
			expect(result).toMatchObject({
				missing: 1,
				mismatch: 2,
				nullLegacy: 0,
				remaining: mode === 'missing' ? 1 : 2,
				exitCode: 0,
			});
			expect(await snapshot()).toEqual(before);
			expect(batchEntries(entries)).toHaveLength(0);
			expect(pause).not.toHaveBeenCalled();
		},
	);

	it('fills only NULLs, crosses unchanged pages and preserves empty/Unicode/long text on restart', async () => {
		const unicode = 'Сохранить\n日本語 😀';
		const long = 'Длинный текст 🧪\n'.repeat(10_000);
		await create('01', 'Already filled', 'Already filled');
		await create('02', 'Another filled row', 'Another filled row');
		await create('03', '');
		await create('04', unicode);
		await create('05', long);
		await create('06', 'Newer legacy', 'Existing non-NULL body');
		const entries: BackfillLogEntry[] = [];
		const pauses: number[] = [];
		const result = await run(
			{},
			{
				logger: (entry) => {
					entries.push(entry);
				},
				pause: async (milliseconds) => {
					pauses.push(milliseconds);
				},
			},
		);
		expect(result).toMatchObject({
			exhausted: true,
			remaining: 0,
			missing: 0,
			mismatch: 1,
			exitCode: 0,
		});
		expect(batchEntries(entries)[0]).toMatchObject({ scanned: 2, updated: 0 });
		expect((await row('03')).body).toBe('');
		expect((await row('04')).body).toBe(unicode);
		const storedLong = await row('05');
		expect(storedLong.body?.length).toBe(long.length);
		expect(
			createHash('sha256')
				.update(storedLong.body ?? '')
				.digest('hex'),
		).toBe(createHash('sha256').update(long).digest('hex'));
		expect((await row('06')).body).toBe('Existing non-NULL body');
		expect(pauses).toEqual(Array(batchEntries(entries).length).fill(100));
		for (const entry of entries) {
			expect(entry).not.toHaveProperty('content');
			expect(entry).not.toHaveProperty('body');
		}
		const beforeRestart = await snapshot();
		const restartedEntries: BackfillLogEntry[] = [];
		await run(
			{},
			{
				logger: (entry) => {
					restartedEntries.push(entry);
				},
			},
		);
		expect(await snapshot()).toEqual(beforeRestart);
		expect(batchEntries(restartedEntries).every((entry) => entry.updated === 0)).toBe(true);
	});

	it('reconciles from current SQL content rather than a previously read value', async () => {
		await create('10', 'First current value', 'First stale body');
		await create('20', 'Legacy before the first batch', 'Second stale body');
		const result = await run(
			{ mode: 'reconcile', batchSize: 1 },
			{
				logger: async (entry) => {
					if (entry.event === 'batch' && entry.batch === 1) {
						await updateLegacyDocument(writer, id('20'), {
							content: 'Latest legacy value before its SQL batch',
						});
					}
				},
			},
		);
		expect(result).toMatchObject({ missing: 0, mismatch: 0, remaining: 0, exitCode: 0 });
		expect((await row('20')).body).toBe('Latest legacy value before its SQL batch');
		const beforeRestart = await snapshot();
		await run({ mode: 'reconcile' });
		expect(await snapshot()).toEqual(beforeRestart);
	});

	it('reports incomplete bounded runs and restarts safely from the beginning', async () => {
		for (const suffix of ['10', '20', '30']) await create(suffix, `Text ${suffix}`);
		const first = await run({ batchSize: 1, maxBatches: 1 });
		expect(first).toMatchObject({ exhausted: false, remaining: 2, exitCode: 2 });
		expect((await row('10')).body).toBe('Text 10');
		const repeated = await run({ batchSize: 1, maxBatches: 1 });
		expect(repeated).toMatchObject({ exhausted: false, remaining: 2, exitCode: 2 });
		const completed = await run({ batchSize: 1, maxBatches: 10 });
		expect(completed).toMatchObject({ exhausted: true, remaining: 0, mismatch: 0, exitCode: 0 });
	});

	it('keeps a committed batch when interrupted and completes on a later run', async () => {
		await create('10', 'First batch');
		await create('20', 'Second batch');
		await expect(
			run(
				{ batchSize: 1 },
				{
					logger: (entry) => {
						if (entry.event === 'batch' && entry.batch === 1)
							throw new Error('Controlled interruption');
					},
				},
			),
		).rejects.toThrow('Controlled interruption');
		expect((await row('10')).body).toBe('First batch');
		expect((await row('20')).body).toBeNull();
		expect(await run()).toMatchObject({ remaining: 0, mismatch: 0, exitCode: 0 });
	});

	it('detects a missing row inserted behind the cursor and finds it on a full restart', async () => {
		await create('20', 'First page');
		await create('40', 'Last page');
		const result = await run(
			{ batchSize: 1 },
			{
				logger: async (entry) => {
					if (entry.event === 'batch' && entry.batch === 1) {
						await create('05', 'New A row', 'New A row');
						// Нарушение writer-контракта должно обнаружиться полным remaining, а не потеряться.
						await create('10', 'Controlled late legacy row');
					}
				},
			},
		);
		expect(result).toMatchObject({ exhausted: true, missing: 1, remaining: 1, exitCode: 2 });
		expect((await row('10')).body).toBeNull();
		expect((await row('05')).body).toBe('New A row');
		expect(await run({ batchSize: 1 })).toMatchObject({
			exhausted: true,
			missing: 0,
			mismatch: 0,
			exitCode: 0,
		});
	});

	it('preserves interleaved atomic A writes and title-only changes between batches', async () => {
		await create('10', 'First page');
		await create('20', 'Old A text');
		await create('30', 'Text with a changing title');
		const result = await run(
			{ batchSize: 1 },
			{
				pause: async () => {
					await updateLegacyDocument(writer, id('20'), {
						content: 'Fresh atomic A value',
						body: 'Fresh atomic A value',
					});
					await updateLegacyDocument(writer, id('30'), { title: 'Renamed concurrently' });
				},
			},
		);
		expect(result).toMatchObject({ missing: 0, mismatch: 0, exitCode: 0 });
		expect(await row('20')).toMatchObject({
			content: 'Fresh atomic A value',
			body: 'Fresh atomic A value',
		});
		expect(await row('30')).toMatchObject({
			title: 'Renamed concurrently',
			body: 'Text with a changing title',
		});
	});

	it('rechecks a waiting UPDATE after an A writer commits without replacing fresh text', async () => {
		await create('10', 'Old visible legacy');
		const locked = gate();
		const release = gate();
		const writing = writer.$transaction(
			async (tx) => {
				await updateLegacyDocument(tx, id('10'), {
					content: 'Fresh committed A value',
					body: 'Fresh committed A value',
				});
				locked.resolve();
				await release.promise;
			},
			{ timeout: 10_000 },
		);
		void writing.catch(locked.reject);
		await locked.promise;
		const entries: BackfillLogEntry[] = [];
		const running = run(
			{},
			{
				logger: (entry) => {
					entries.push(entry);
				},
			},
		);
		void running.catch(() => undefined);
		try {
			const deadline = Date.now() + 650;
			let waiting = false;
			while (Date.now() < deadline && !waiting) {
				const [state] = await observer.$queryRaw<Array<{ waiting: boolean }>>`
					SELECT EXISTS (
						SELECT 1 FROM pg_stat_activity
						WHERE datname = current_database() AND wait_event_type = 'Lock'
							AND query LIKE '%WITH page AS%' AND query LIKE '%UPDATE "Document"%'
					) AS waiting
				`;
				waiting = state.waiting;
				if (!waiting) await delay(5);
			}
			expect(waiting).toBe(true);
			expect(entries[0]).toMatchObject({ event: 'start', missing: 1, mismatch: 1 });
			release.resolve();
			await writing;
			expect(await running).toMatchObject({ missing: 0, mismatch: 0, exitCode: 0 });
			expect(await row('10')).toMatchObject({
				content: 'Fresh committed A value',
				body: 'Fresh committed A value',
			});
			expect(batchEntries(entries)[0]).toMatchObject({ scanned: 1, updated: 0 });
		} finally {
			release.resolve();
			await writing;
			await running.catch(() => undefined);
		}
	});

	it('rolls back a lock-timed-out batch while preserving earlier committed batches', async () => {
		for (const suffix of ['10', '20', '30', '40']) await create(suffix, `Text ${suffix}`);
		const locked = gate();
		const release = gate();
		let blocking: Promise<void> | undefined;
		try {
			const running = run(
				{},
				{
					logger: async (entry) => {
						if (entry.event !== 'batch' || entry.batch !== 1) return;
						blocking = writer.$transaction(
							async (tx) => {
								await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${id('40')} FOR UPDATE`;
								locked.resolve();
								await release.promise;
							},
							{ timeout: 10_000 },
						);
						void blocking.catch(locked.reject);
						await locked.promise;
					},
				},
			);
			await expect(running).rejects.toMatchObject({
				code: 'P2010',
				meta: expect.objectContaining({ code: '55P03' }),
			});
			expect((await row('10')).body).toBe('Text 10');
			expect((await row('20')).body).toBe('Text 20');
			expect((await row('30')).body).toBeNull();
			expect((await row('40')).body).toBeNull();
			expect(await readCounts(prisma)).toEqual({ missing: 2, mismatch: 2, nullLegacy: 0 });
		} finally {
			release.resolve();
			await blocking;
		}
		expect(await run()).toMatchObject({ remaining: 0, mismatch: 0, exitCode: 0 });
	});
});
