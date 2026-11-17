import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { YooKassaPaymentProvider } from '../src/payments/yookassa-payment.provider';
import { isolatedConfig } from './test-config';
import { YooKassaStub } from './task8-yookassa-stub';

describe('Task 8 YooKassa HTTP adapter without a database', () => {
	const stub = new YooKassaStub();
	let provider: YooKassaPaymentProvider;
	const makeProvider = (overrides: Record<string, unknown> = {}) =>
		new YooKassaPaymentProvider(
			isolatedConfig({
				PAYMENT_MODE: 'test',
				YOOKASSA_SHOP_ID: stub.shopId,
				YOOKASSA_SECRET_KEY: 'test_task8_key',
				PAYMENT_RETURN_BASE_URL: 'http://localhost:5173',
				PAYMENT_HTTP_TIMEOUT_MS: 500,
				...overrides,
			}),
			stub.baseUrl,
		);
	const requestBody = (): Prisma.JsonValue => ({
		amount: { value: '100.00', currency: 'RUB' },
		capture: true,
		confirmation: {
			type: 'redirect',
			return_url: `http://localhost:5173/payments/${randomUUID()}/result`,
		},
		description: 'Test workspace payment',
		metadata: { paymentId: randomUUID(), workspaceId: 'task8-provider-workspace' },
	});
	beforeAll(async () => {
		await stub.start();
		provider = makeProvider();
	});
	afterEach(() => stub.resetFaults());
	afterAll(async () => stub.close());

	it('sends the saved body and provider Idempotence-Key over authenticated HTTP', async () => {
		const key = randomUUID();
		const body = requestBody();
		const response = await provider.create(body, key);
		expect(stub.creates.at(-1)).toEqual({ key, body, serializedBody: JSON.stringify(body) });
		expect(response).toMatchObject({
			status: 'pending',
			test: true,
			recipient: { account_id: stub.shopId },
		});
		const snapshot = await provider.get(response.id);
		expect(snapshot.id).toBe(response.id);
		expect(stub.gets.at(-1)).toBe(response.id);
	});

	it.each([
		{ PAYMENT_MODE: 'live' },
		{ YOOKASSA_SECRET_KEY: '' },
		{ YOOKASSA_SECRET_KEY: 'live_invalid_example' },
		{ YOOKASSA_SHOP_ID: '' },
		{ PAYMENT_RETURN_BASE_URL: 'javascript:alert(1)' },
		{ PAYMENT_RETURN_BASE_URL: 'https://user:password@example.test' },
	])('refuses missing or unsafe configuration before dispatch: %p', async (overrides) => {
		const unconfigured = makeProvider(overrides);
		const count = stub.creates.length;
		expect(unconfigured.isConfigured()).toBe(false);
		await expect(unconfigured.create(requestBody(), randomUUID())).rejects.toBeInstanceOf(
			ServiceUnavailableException,
		);
		expect(stub.creates).toHaveLength(count);
	});

	it.each([
		['live snapshot', { test: false }],
		['foreign shop', { recipient: { account_id: '987654321' } }],
	])('rejects %s returned over authenticated HTTP', async (_name, changes) => {
		stub.transformNextResponse((snapshot) => ({ ...snapshot, ...changes }));
		await expect(provider.create(requestBody(), randomUUID())).rejects.toMatchObject({
			code: 'PROVIDER_SHOP_OR_MODE_MISMATCH',
		});
	});

	it('does not turn a provider 500 into a successful or terminal payment', async () => {
		stub.failNextCreate(500);
		await expect(provider.create(requestBody(), randomUUID())).rejects.toMatchObject({
			code: 'PROVIDER_HTTP_500',
		});
	});

	it('rejects invalid provider shapes and unsafe confirmation URLs', async () => {
		stub.transformNextResponse((snapshot) => ({ ...snapshot, status: 'invented-success' }));
		await expect(provider.create(requestBody(), randomUUID())).rejects.toMatchObject({
			code: 'PROVIDER_INVALID_RESPONSE',
		});
		stub.transformNextResponse((snapshot) => ({
			...snapshot,
			confirmation: { type: 'redirect', confirmation_url: 'javascript:alert(1)' },
		}));
		await expect(provider.create(requestBody(), randomUUID())).rejects.toMatchObject({
			code: 'PROVIDER_INVALID_CONFIRMATION',
		});
	});

	it('rejects a different ID in a GET response and path injection before issuing GET', async () => {
		const created = await provider.create(requestBody(), randomUUID());
		stub.transformNextResponse((snapshot) => ({ ...snapshot, id: randomUUID() }));
		await expect(provider.get(created.id)).rejects.toMatchObject({ code: 'PROVIDER_ID_MISMATCH' });
		const gets = stub.gets.length;
		await expect(provider.get('../payments?attacker=1')).rejects.toMatchObject({
			code: 'PROVIDER_INVALID_ID',
		});
		expect(stub.gets).toHaveLength(gets);
	});

	it('bounds a request whose external operation was accepted but whose response is held', async () => {
		const shortTimeout = makeProvider({ PAYMENT_HTTP_TIMEOUT_MS: 100 });
		const held = stub.holdNextCreate();
		const key = randomUUID();
		const call = shortTimeout.create(requestBody(), key);
		const rejected = expect(call).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
		const external = await held.ready;
		try {
			await rejected;
			expect(stub.payments.has(external.payment.id)).toBe(true);
			expect(stub.creates.at(-1)!.key).toBe(key);
		} finally {
			held.release();
		}
	});
});
