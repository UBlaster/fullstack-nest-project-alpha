import {
	BackfillContract,
	loadBackfillContract,
	shouldRunBackfillUnitTests,
} from './backfill-document-body-contract';

const describeBackfillGuard = shouldRunBackfillUnitTests() ? describe : describe.skip;

describeBackfillGuard('Document body backfill generated-client guard (no database/network)', () => {
	let assertReleaseAClient: BackfillContract['assertReleaseAClient'];

	beforeAll(async () => {
		({ assertReleaseAClient } = await loadBackfillContract());
	});

	it('accepts the Release A DMMF with required legacy and nullable body', () => {
		expect(() =>
			assertReleaseAClient([
				{
					name: 'Document',
					fields: [
						{ name: 'content', isRequired: true },
						{ name: 'body', isRequired: false },
					],
				},
			]),
		).not.toThrow();
	});

	it.each([
		{ label: 'R0', fields: [{ name: 'content', isRequired: true }] },
		{
			label: 'B/C',
			fields: [
				{ name: 'content', isRequired: false },
				{ name: 'body', isRequired: false },
			],
		},
		{ label: 'D', fields: [{ name: 'body', isRequired: true }] },
		{
			label: 'required body',
			fields: [
				{ name: 'content', isRequired: true },
				{ name: 'body', isRequired: true },
			],
		},
	])('rejects the incompatible $label DMMF', ({ fields }) => {
		expect(() => assertReleaseAClient([{ name: 'Document', fields }])).toThrow(
			'BACKFILL_REQUIRES_RELEASE_A_CLIENT',
		);
	});

	it('rejects the generated Prisma Client for Release D', () => {
		expect(() => assertReleaseAClient()).toThrow('BACKFILL_REQUIRES_RELEASE_A_CLIENT');
	});

	it('fails closed when Document metadata is missing', () => {
		expect(() => assertReleaseAClient([])).toThrow('BACKFILL_REQUIRES_RELEASE_A_CLIENT');
	});
});
