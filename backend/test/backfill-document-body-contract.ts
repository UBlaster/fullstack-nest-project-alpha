import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

// Acceptance contract only: the implementation is loaded lazily and is never supplied by tests.
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

export interface BackfillResult extends BackfillCounts {
	exhausted: boolean;
	remaining: number;
	exitCode: 0 | 2;
}

export type BackfillLogEntry =
	| ({ event: 'start' } & BackfillOptions & BackfillCounts)
	| ({ event: 'dry-run'; mode: BackfillOptions['mode']; remaining: number } & BackfillCounts)
	| {
			event: 'batch';
			mode: BackfillOptions['mode'];
			batch: number;
			scanned: number;
			updated: number;
			cursor: string | null;
	  }
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

interface ClientModel {
	name: string;
	fields: readonly { name: string; isRequired: boolean }[];
}

export interface BackfillContract {
	parseOptions(args: readonly string[]): BackfillOptions;
	assertReleaseAClient(models?: readonly ClientModel[]): void;
	readCounts(prisma: PrismaClient): Promise<BackfillCounts>;
	runBackfill(
		prisma: PrismaClient,
		options: BackfillOptions,
		hooks?: BackfillHooks,
	): Promise<BackfillResult>;
}

const implementationPath = resolve(__dirname, '../scripts/backfill-document-body.ts');

export function shouldRunBackfillUnitTests(): boolean {
	return existsSync(implementationPath) || process.env.TASK7_BACKFILL_E2E === 'true';
}

function hasBackfillExports(value: unknown): value is BackfillContract {
	return (
		typeof value === 'object' &&
		value !== null &&
		'parseOptions' in value &&
		typeof value.parseOptions === 'function' &&
		'assertReleaseAClient' in value &&
		typeof value.assertReleaseAClient === 'function' &&
		'readCounts' in value &&
		typeof value.readCounts === 'function' &&
		'runBackfill' in value &&
		typeof value.runBackfill === 'function'
	);
}

export async function loadBackfillContract(): Promise<BackfillContract> {
	if (!existsSync(implementationPath)) {
		throw new Error(
			'Task 7 backfill implementation is required: create backend/scripts/backfill-document-body.ts',
		);
	}
	const implementation: unknown = await import(implementationPath);
	if (!hasBackfillExports(implementation)) {
		throw new Error(
			'Task 7 backfill must export parseOptions, assertReleaseAClient, readCounts and runBackfill',
		);
	}
	return implementation;
}
