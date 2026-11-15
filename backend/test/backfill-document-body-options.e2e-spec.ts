import {
	BackfillContract,
	loadBackfillContract,
	shouldRunBackfillUnitTests,
} from './backfill-document-body-contract';

const describeBackfillOptions = shouldRunBackfillUnitTests() ? describe : describe.skip;

describeBackfillOptions('Document body backfill CLI options (no database/network)', () => {
	let parseOptions: BackfillContract['parseOptions'];

	beforeAll(async () => {
		({ parseOptions } = await loadBackfillContract());
	});

	it('uses the bounded missing-only defaults', () => {
		expect(parseOptions([])).toEqual({
			dryRun: false,
			mode: 'missing',
			batchSize: 500,
			maxBatches: 100,
		});
	});

	it('accepts an explicit reconciliation dry-run with independent limits', () => {
		expect(
			parseOptions(['--mode=reconcile', '--dry-run', '--batch-size=17', '--max-batches=3']),
		).toEqual({ dryRun: true, mode: 'reconcile', batchSize: 17, maxBatches: 3 });
	});

	it('accepts the documented upper bounds without rounding', () => {
		expect(parseOptions(['--batch-size=10000', '--max-batches=1000000'])).toMatchObject({
			batchSize: 10_000,
			maxBatches: 1_000_000,
		});
	});

	it.each([
		['--dry-run', '--dry-run'],
		['--mode=missing', '--mode=reconcile'],
		['--batch-size=1', '--batch-size=2'],
		['--max-batches=1', '--max-batches=2'],
		['--dry-run=true'],
		['--unknown=1'],
		['--mode', 'missing'],
		['--mode='],
		['--mode=replace'],
		['--batch-size=0'],
		['--batch-size=-1'],
		['--batch-size=1.5'],
		['--batch-size=1e3'],
		['--batch-size=01'],
		['--batch-size=NaN'],
		['--batch-size=10001'],
		['--batch-size=9007199254740993'],
		['--max-batches=0'],
		['--max-batches=-1'],
		['--max-batches=1000001'],
	])('rejects invalid or duplicate arguments %j', (...args) => {
		expect(() => parseOptions(args)).toThrow();
	});
});
