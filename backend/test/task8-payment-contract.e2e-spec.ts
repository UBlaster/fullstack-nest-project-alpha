import { randomUUID } from 'node:crypto';
import { createPaymentContractHarness } from './task8-payment-contract.harness';
import type { ContractPayment, PaymentContractHarness } from './task8-payment-contract.types';

const describeContract = process.env.TASK8_CONTRACT_TESTS === 'true' ? describe : describe.skip;

describeContract('Task 8 shared payment contract with a mocked provider', () => {
	let harness: PaymentContractHarness;
	const paymentPath = (id: string) => `/payments/${id}`;
	const workspacePath = () => `/workspaces/${harness.workspaceId}/payments`;
	const create = async (key = randomUUID(), workspaceId = harness.workspaceId) => {
		const response = await harness.request('POST', `/workspaces/${workspaceId}/payments`, {
			key,
			body: { purpose: 'WORKSPACE_DEMO' },
		});
		expect([200, 201, 202]).toContain(response.status);
		return { ...response, payment: response.body as ContractPayment };
	};
	const read = async (id: string) => {
		const response = await harness.request('GET', paymentPath(id));
		expect(response.status).toBe(200);
		return response.body as ContractPayment;
	};

	beforeEach(async () => {
		harness = await createPaymentContractHarness();
	});
	afterEach(async () => {
		await harness?.close();
	});

	it('uses server price and currency, and exposes no internal payment state', async () => {
		const capabilities = await harness.request('GET', `${workspacePath()}/capabilities`);
		expect(capabilities.status).toBe(200);
		const price = capabilities.body as { enabled: boolean; amountMinor: number; currency: string };
		expect(price.enabled).toBe(true);
		expect(Number.isSafeInteger(price.amountMinor) && price.amountMinor > 0).toBe(true);
		expect(price.currency).toMatch(/^[A-Z]{3}$/);
		const response = await harness.request('POST', workspacePath(), {
			key: randomUUID(),
			body: { purpose: 'WORKSPACE_DEMO', amountMinor: 1, currency: 'XXX' },
		});
		expect(response.status).toBe(201);
		expect(response.body).toMatchObject({
			amountMinor: price.amountMinor,
			currency: price.currency,
		});
		for (const field of [
			'userId',
			'idempotencyKey',
			'requestHash',
			'providerIdempotenceKey',
			'providerRequest',
			'providerPaymentId',
			'leaseToken',
			'leaseUntil',
			'version',
		])
			expect(response.body).not.toHaveProperty(field);
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
		const held = harness.provider.holdNextCreate();
		const leader = create(key);
		try {
			await held.started;
			const followers = await Promise.all(Array.from({ length: 5 }, () => create(key)));
			expect(followers.every((response) => response.status === 202)).toBe(true);
			expect(new Set(followers.map((response) => response.payment.id)).size).toBe(1);
			expect(harness.provider.creates).toHaveLength(1);
			held.release();
			const first = await leader;
			expect(followers[0].payment.id).toBe(first.payment.id);
		} finally {
			held.release();
			await leader;
		}
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

	it('deduplicates verified notifications and preserves success after an older pending snapshot', async () => {
		const { payment } = await create();
		harness.provider.setStatus(payment.id, 'succeeded');
		await harness.notify(payment.id);
		const audits = await harness.auditCount(payment.id);
		await harness.notify(payment.id);
		expect(await harness.auditCount(payment.id)).toBe(audits);
		harness.provider.setStatus(payment.id, 'pending');
		await harness.notify(payment.id);
		expect((await read(payment.id)).status).toBe('SUCCEEDED');
	});

	it.each(['member', 'viewer', 'outsider', 'anonymous'] as const)(
		'restricts payment creation, reads, history, reconciliation and SSE for %s',
		async (user) => {
			const { payment } = await create();
			const expected = user === 'anonymous' ? 401 : user === 'outsider' ? 404 : 403;
			for (const [method, path] of [
				['GET', paymentPath(payment.id)],
				['GET', workspacePath()],
				['GET', `${paymentPath(payment.id)}/events`],
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

	it('SSE sends the initial snapshot and a saved transition, then reconnects with current state', async () => {
		const { payment } = await create();
		const stream = await harness.events(payment.id);
		try {
			expect((await stream.next()).status).toBe('PENDING');
			harness.provider.setStatus(payment.id, 'succeeded');
			await harness.notify(payment.id);
			expect((await stream.next()).status).toBe('SUCCEEDED');
		} finally {
			await stream.close();
		}
		const reconnected = await harness.events(payment.id);
		try {
			expect((await reconnected.next()).status).toBe('SUCCEEDED');
		} finally {
			await reconnected.close();
		}
	});
});
