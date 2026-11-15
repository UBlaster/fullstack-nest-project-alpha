import { Prisma, PrismaClient } from '@prisma/client';
import { setTimeout as delay } from 'node:timers/promises';

export interface BackfillOptions {
	dryRun: boolean;
	mode: 'missing' | 'reconcile';
	batchSize: number;
	maxBatches: number;
}

export interface BackfillCounts {
	missing: number;
	mismatch: number;
	nullLegacy: number;
}

interface BatchResult {
	scanned: number;
	updated: number;
	cursor: string | null;
}

export interface BackfillResult extends BackfillCounts {
	exhausted: boolean;
	remaining: number;
	exitCode: 0 | 2;
}

export type BackfillLogEntry =
	| ({ event: 'start' } & BackfillOptions & BackfillCounts)
	| ({ event: 'dry-run'; mode: BackfillOptions['mode']; remaining: number } & BackfillCounts)
	| ({ event: 'batch'; mode: BackfillOptions['mode']; batch: number } & BatchResult)
	| ({
			event: 'finish';
			mode: BackfillOptions['mode'];
			exhausted: boolean;
			remaining: number;
	  } & BackfillCounts);

export interface BackfillHooks {
	logger?: (entry: BackfillLogEntry) => void | Promise<void>;
	pause?: (milliseconds: number) => Promise<void>;
}

const releaseAClientErrorCode = 'BACKFILL_REQUIRES_RELEASE_A_CLIENT';

interface ClientModel {
	name: string;
	fields: readonly { name: string; isRequired: boolean }[];
}

export function assertReleaseAClient(
	models: readonly ClientModel[] = Prisma.dmmf.datamodel.models,
) {
	const document = models.find((model) => model.name === 'Document');
	const content = document?.fields.find((field) => field.name === 'content');
	const body = document?.fields.find((field) => field.name === 'body');
	if (content?.isRequired !== true || body?.isRequired !== false) {
		throw new Error(releaseAClientErrorCode);
	}
}

export function parseOptions(args: readonly string[]): BackfillOptions {
	const values = new Map<string, string>();
	let dryRun = false;
	for (const arg of args) {
		if (arg === '--dry-run' && !dryRun) {
			dryRun = true;
			continue;
		}
		const match = /^(--mode|--batch-size|--max-batches)=(.+)$/.exec(arg);
		if (!match || values.has(match[1])) throw new Error('Invalid or duplicate flag');
		values.set(match[1], match[2]);
	}
	const positiveInteger = (flag: string, fallback: number, maximum: number) => {
		const raw = values.get(flag);
		if (raw !== undefined && !/^[1-9]\d*$/.test(raw)) {
			throw new Error('Expected positive integer');
		}
		const value = raw === undefined ? fallback : Number(raw);
		if (!Number.isSafeInteger(value) || value > maximum) {
			throw new Error('Flag is outside its allowed range');
		}
		return value;
	};
	const mode = values.get('--mode') ?? 'missing';
	if (mode !== 'missing' && mode !== 'reconcile') throw new Error('Invalid mode');
	return {
		dryRun,
		mode,
		batchSize: positiveInteger('--batch-size', 500, 10_000),
		maxBatches: positiveInteger('--max-batches', 100, 1_000_000),
	};
}

export async function readCounts(prisma: PrismaClient): Promise<BackfillCounts> {
	const [row] = await prisma.$queryRaw<BackfillCounts[]>`
		SELECT
			(COUNT(*) FILTER (WHERE "body" IS NULL))::int AS missing,
			(COUNT(*) FILTER (WHERE "body" IS DISTINCT FROM "content"))::int AS mismatch,
			(COUNT(*) FILTER (WHERE "content" IS NULL))::int AS "nullLegacy"
		FROM "Document"
	`;
	return row;
}

export async function runBackfill(
	prisma: PrismaClient,
	options: BackfillOptions,
	hooks: BackfillHooks = {},
): Promise<BackfillResult> {
	const logger = hooks.logger ?? ((entry: BackfillLogEntry) => console.info(JSON.stringify(entry)));
	const pause = hooks.pause ?? delay;
	const before = await readCounts(prisma);
	await logger({ event: 'start', ...options, ...before });
	if (before.nullLegacy !== 0) throw new Error('Legacy source is incomplete');
	if (options.dryRun) {
		const remaining = options.mode === 'missing' ? before.missing : before.mismatch;
		await logger({ event: 'dry-run', mode: options.mode, remaining, ...before });
		return { ...before, exhausted: false, remaining, exitCode: 0 };
	}

	const condition =
		options.mode === 'missing'
			? Prisma.sql`d."body" IS NULL`
			: Prisma.sql`d."body" IS DISTINCT FROM d."content"`;
	let cursor: string | null = null;
	let exhausted = false;

	for (let batch = 1; batch <= options.maxBatches; batch += 1) {
		const result: BatchResult = await prisma.$transaction(
			async (tx) => {
				await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
				await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
				const [row] = await tx.$queryRaw<BatchResult[]>`
					WITH page AS (
						SELECT "id" FROM "Document"
						WHERE (${cursor}::text IS NULL OR "id" > ${cursor}::text)
						ORDER BY "id"
						LIMIT ${options.batchSize}
					), changed AS (
						UPDATE "Document" AS d
						SET "body" = d."content"
						FROM page
						WHERE d."id" = page."id"
							AND d."content" IS NOT NULL
							AND ${condition}
						RETURNING d."id"
					)
					SELECT
						(SELECT COUNT(*)::int FROM page) AS scanned,
						(SELECT COUNT(*)::int FROM changed) AS updated,
						(SELECT MAX("id") FROM page) AS cursor
				`;
				return row;
			},
			{ maxWait: 2_000, timeout: 10_000 },
		);
		// Progress и пауза идут после commit: locks партии уже освобождены.
		await logger({ event: 'batch', mode: options.mode, batch, ...result });
		await pause(100);
		if (result.scanned === 0) {
			exhausted = true;
			break;
		}
		cursor = result.cursor;
	}

	// Конец keyset-прохода не доказывает полноту: проверяем всю таблицу.
	const after = await readCounts(prisma);
	const remaining = options.mode === 'missing' ? after.missing : after.mismatch;
	await logger({ event: 'finish', mode: options.mode, exhausted, remaining, ...after });
	return { ...after, exhausted, remaining, exitCode: remaining === 0 ? 0 : 2 };
}

async function main(args: readonly string[]): Promise<void> {
	const options = parseOptions(args);
	assertReleaseAClient();
	const prisma = new PrismaClient();
	try {
		const result = await runBackfill(prisma, options);
		process.exitCode = result.exitCode;
	} finally {
		await prisma.$disconnect();
	}
}

if (require.main === module) {
	void main(process.argv.slice(2)).catch((error: unknown) => {
		const code =
			error instanceof Error && error.message === releaseAClientErrorCode
				? releaseAClientErrorCode
				: error instanceof Prisma.PrismaClientKnownRequestError
					? error.code
					: 'BACKFILL_FAILED';
		console.error(JSON.stringify({ event: 'failed', code }));
		process.exitCode = 1;
	});
}
