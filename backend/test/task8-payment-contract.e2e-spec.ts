import { randomUUID } from 'node:crypto';
import { paymentContractBinding } from './task8-payment-contract.binding';
import { createPaymentContractHarness } from './task8-payment-contract.harness';
import type {
	ContractPayment,
	PaymentContractBinding,
	PaymentContractHarness,
} from './task8-payment-contract.types';

const describeContract = process.env.TASK8_CONTRACT_TESTS === 'true' ? describe : describe.skip;

describeContract('Task 8 shared payment contract with a mocked provider', () => {
	let harness: PaymentContractHarness;
	let binding: PaymentContractBinding;
	const paymentPath = (id: string) => `/payments/${id}`;
	const workspacePath = () => `/workspaces/${harness.workspaceId}/payments`;
	const create = async (key = randomUUID(), workspaceId = harness.workspaceId) => {
		const response = await harness.request('POST', `/workspaces/${workspaceId}/payments`, {
			key,
			body: { purpose: 'WORKSPACE_DEMO' },
		});
		expect([200, 201, 202]).toContain(response.status);
		const payment = response.body as ContractPayment;
		expect(payment.id).toEqual(expect.any(String));
		expect(payment.workspaceId).toBe(workspaceId);
		return { status: response.status, payment };
	};
	const read = async (id: string) => {
		const response = await harness.request('GET', paymentPath(id));
		expect(response.status).toBe(200);
		return response.body as ContractPayment;
	};

	beforeAll(() => {
		binding = paymentContractBinding();
	});
	beforeEach(async () => {
		harness = await createPaymentContractHarness(binding);
	});
	afterEach(async () => {
		if (harness) await harness.close();
	});

	const privateFields = [
		'userId',
		'idempotencyKey',
		'requestHash',
		'providerIdempotenceKey',
		'providerRequest',
		'providerPaymentId',
		'leaseToken',
		'leaseUntil',
		'version',
	];

	it('uses server price and currency, and exposes no internal payment state', async () => {
		const { status, payment } = await create();
		expect(status).toBe(201);
		expect(Number.isSafeInteger(payment.amountMinor) && payment.amountMinor > 0).toBe(true);
		expect(payment.currency).toMatch(/^[A-Z]{3}$/);
		expect(harness.provider.forPayment(payment.id)).toMatchObject({
			amountMinor: payment.amountMinor,
			currency: payment.currency,
		});
		const calls = harness.provider.creates.length;
		const response = await harness.request('POST', workspacePath(), {
			key: randomUUID(),
			body: { purpose: 'WORKSPACE_DEMO', amountMinor: 1, currency: 'XXX' },
		});
		if (response.status === 400) {
			expect(harness.provider.creates).toHaveLength(calls);
		} else {
			expect(response.status).toBe(201);
			expect(response.body).toMatchObject({
				amountMinor: payment.amountMinor,
				currency: payment.currency,
			});
			expect(harness.provider.forPayment((response.body as ContractPayment).id)).toMatchObject({
				amountMinor: payment.amountMinor,
				currency: payment.currency,
			});
			for (const field of privateFields) expect(response.body).not.toHaveProperty(field);
		}
		const stored = await read(payment.id);
		const history = await harness.request('GET', workspacePath());
		expect(history.status).toBe(200);
		expect(history.body).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: payment.id })]),
		);
		for (const value of [payment, stored, ...(history.body as ContractPayment[])]) {
			for (const field of privateFields) expect(value).not.toHaveProperty(field);
		}
	});

	it('replays one logical payment without another provider create', async () => {
		const key = randomUUID();
		const first = await create(key);
		const calls = harness.provider.creates.length;
		const replay = await create(key);
		expect(replay.status).toBe(200);
		expect(replay.payment.id).toBe(first.payment.id);
		expect(harness.provider.creates).toHaveLength(calls);
	});

	it('reserves one payment during concurrent requests', async () => {
		const key = randomUUID();
		harness.provider.createDelayMs = 100;
		const responses = await Promise.allSettled(Array.from({ length: 6 }, () => create(key)));
		const created = responses.map((response) => {
			if (response.status === 'rejected') throw response.reason;
			return response.value;
		});
		expect(created.filter((response) => response.status === 201)).toHaveLength(1);
		expect(new Set(created.map((response) => response.payment.id)).size).toBe(1);
		expect(harness.provider.creates).toHaveLength(1);
		const history = await harness.request('GET', workspacePath());
		expect(history.status).toBe(200);
		expect(history.body).toHaveLength(1);
	});

	it('rejects reuse of a key for a different workspace', async () => {
		const key = randomUUID();
		await create(key);
		const response = await harness.request(
			'POST',
			`/workspaces/${harness.otherWorkspaceId}/payments`,
			{
				key,
				body: { purpose: 'WORKSPACE_DEMO' },
			},
		);
		expect(response.status).toBe(409);
		expect(harness.provider.creates).toHaveLength(1);
	});

	it('keeps an unknown create outcome recoverable with the original provider key and body', async () => {
		harness.provider.loseNextCreateResponse = true;
		const first = await create();
		expect(first.status).toBe(202);
		expect(first.payment.status).toBe('CREATED');
		const original = structuredClone(harness.provider.creates[0]);
		const recovered = await harness.request('POST', `${paymentPath(first.payment.id)}/reconcile`);
		expect(recovered.status).toBe(200);
		expect(recovered.body).toMatchObject({ id: first.payment.id, status: 'PENDING' });
		expect(harness.provider.creates).toHaveLength(2);
		expect(harness.provider.creates.at(-1)).toEqual(original);
	});

	it('a local GET only reports saved state; reconciliation applies verified provider state', async () => {
		const { payment } = await create();
		harness.provider.setStatus(payment.id, 'succeeded');
		const reads = harness.provider.reads.length;
		expect((await read(payment.id)).status).toBe('PENDING');
		expect(harness.provider.reads).toHaveLength(reads);
		const response = await harness.request('POST', `${paymentPath(payment.id)}/reconcile`);
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ status: 'SUCCEEDED', confirmationUrl: null });
	});

	it('deduplicates notifications and preserves success on a distinct late notification', async () => {
		const { payment } = await create();
		const before = await harness.records(payment.id);
		harness.provider.setStatus(payment.id, 'succeeded');
		await harness.notify(payment.id, 'succeeded');
		expect((await read(payment.id)).status).toBe('SUCCEEDED');
		const applied = await harness.records(payment.id);
		expect(applied).toEqual({ events: before.events + 1, changes: before.changes + 1 });
		await harness.notify(payment.id, 'succeeded');
		expect(await harness.records(payment.id)).toEqual(applied);
		harness.provider.setStatus(payment.id, 'canceled');
		await harness.notify(payment.id, 'canceled');
		expect((await read(payment.id)).status).toBe('SUCCEEDED');
		expect(await harness.records(payment.id)).toEqual({
			events: applied.events + 1,
			changes: applied.changes,
		});
	});

	it.each(['member', 'viewer', 'outsider', 'anonymous'] as const)(
		'restricts payment creation, reads, history and reconciliation for %s',
		async (user) => {
			const { payment } = await create();
			const expected = user === 'anonymous' ? 401 : user === 'outsider' ? 404 : 403;
			for (const [method, path] of [
				['GET', paymentPath(payment.id)],
				['GET', workspacePath()],
				['POST', `${paymentPath(payment.id)}/reconcile`],
				['POST', workspacePath()],
			] as const) {
				const response = await harness.request(method, path, {
					user,
					key: randomUUID(),
					body: method === 'POST' ? { purpose: 'WORKSPACE_DEMO' } : undefined,
				});
				expect(response.status).toBe(expected);
			}
		},
	);

	it('validates the attempt key and purchase purpose before calling the provider', async () => {
		for (const options of [
			{ body: { purpose: 'WORKSPACE_DEMO' } },
			{ key: 'invalid', body: { purpose: 'WORKSPACE_DEMO' } },
			{ key: randomUUID(), body: { purpose: 'OTHER' } },
		])
			expect((await harness.request('POST', workspacePath(), options)).status).toBe(400);
		expect(harness.provider.creates).toHaveLength(0);
	});
});
