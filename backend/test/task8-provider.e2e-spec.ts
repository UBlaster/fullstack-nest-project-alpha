import { randomUUID } from 'node:crypto';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as Stripe from 'stripe';
import { StripePaymentProvider } from '../src/payments/stripe-payment.provider';
import { isolatedConfig } from './test-config';
import { StripeStub } from './task8-stripe-stub';

const webhookSecret = 'whsec_task8_test';

describe('Task 8 Stripe SDK adapter and signed webhooks without a database', () => {
	const stub = new StripeStub();
	let provider: StripePaymentProvider;
	const makeProvider = (overrides: Record<string, unknown> = {}) =>
		new StripePaymentProvider(
			isolatedConfig({
				PAYMENT_MODE: 'test',
				STRIPE_SECRET_KEY: stub.apiKey,
				STRIPE_WEBHOOK_SECRET: webhookSecret,
				PAYMENT_RETURN_BASE_URL: 'http://localhost:5173',
				PAYMENT_HTTP_TIMEOUT_MS: 500,
				...overrides,
			}),
			stub.baseUrl,
		);
	const requestBody = (): Prisma.JsonValue =>
		JSON.parse(
			JSON.stringify(provider.requestFor(randomUUID(), 'task8-provider-workspace')),
		) as Prisma.JsonValue;
	const signed = (
		changes: Record<string, unknown> = {},
		secret = webhookSecret,
		timestamp?: number,
	) => {
		const raw = JSON.stringify(
			{
				id: 'evt_test_task8',
				object: 'event',
				type: 'checkout.session.completed',
				livemode: false,
				data: { object: { id: 'cs_test_signedsession', object: 'checkout.session' } },
				...changes,
			},
			null,
			2,
		);
		return {
			raw: Buffer.from(raw),
			signature: Stripe.webhooks.generateTestHeaderString({ payload: raw, secret, timestamp }),
		};
	};
	beforeAll(async () => {
		await stub.start();
		provider = makeProvider();
	});
	afterEach(() => stub.resetFaults());
	afterAll(async () => stub.close());

	it('uses the official SDK for saved card-only $10 parameters, auth, idempotency and GET', async () => {
		const body = requestBody();
		const key = randomUUID();
		const before = stub.creates.length;
		const response = await provider.create(body, key);
		expect(stub.creates).toHaveLength(before + 1);
		expect(stub.creates.at(-1)).toMatchObject({ key, body });
		expect(response).toMatchObject({
			provider: 'stripe',
			status: 'pending',
			test: true,
			amountMinor: 1000,
			currency: 'USD',
		});
		expect(response.clientReferenceId).toBe(response.metadata.paymentId);
		expect((await provider.get(response.id)).id).toBe(response.id);
		expect(stub.gets.at(-1)).toBe(response.id);
	});

	it('reuses saved Checkout URLs after the return base changes', async () => {
		const body = requestBody();
		const key = randomUUID();
		const created = await provider.create(body, key);
		const restarted = makeProvider({ PAYMENT_RETURN_BASE_URL: 'https://app.example.test' });

		expect((await restarted.create(body, key)).id).toBe(created.id);
		expect(stub.creates.at(-1)).toEqual(stub.creates.at(-2));
		expect(stub.creates.at(-1)).toMatchObject({ key, body });
	});

	it.each([
		{ PAYMENT_MODE: 'live' },
		{ STRIPE_SECRET_KEY: '' },
		{ STRIPE_SECRET_KEY: 'sk_live_invalid_example' },
		{ STRIPE_WEBHOOK_SECRET: '' },
		{ PAYMENT_RETURN_BASE_URL: 'javascript:alert(1)' },
		{ PAYMENT_RETURN_BASE_URL: 'https://user:password@example.test' },
	])('refuses missing or unsafe test configuration before any POST: case %#', async (overrides) => {
		const unconfigured = makeProvider(overrides);
		const count = stub.creates.length;
		expect(unconfigured.isConfigured()).toBe(false);
		await expect(unconfigured.create(requestBody(), randomUUID())).rejects.toBeInstanceOf(
			ServiceUnavailableException,
		);
		expect(stub.creates).toHaveLength(count);
	});

	it.each([
		['open', 'unpaid', 'pending'],
		['complete', 'unpaid', 'pending'],
		['complete', 'paid', 'succeeded'],
		['expired', 'unpaid', 'canceled'],
	] as const)('normalizes Session %s/%s into %s', async (status, payment_status, expected) => {
		const created = await provider.create(requestBody(), randomUUID());
		stub.change(created.id, { status, payment_status });
		expect((await provider.get(created.id)).status).toBe(expected);
	});

	it.each([
		['open', 'paid'],
		['expired', 'paid'],
		['complete', 'no_payment_required'],
	] as const)(
		'refuses contradictory or free Session %s/%s for the fixed paid purchase',
		async (status, payment_status) => {
			const created = await provider.create(requestBody(), randomUUID());
			stub.change(created.id, { status, payment_status });
			await expect(provider.get(created.id)).rejects.toMatchObject({
				code: 'PROVIDER_INVALID_RESPONSE',
			});
		},
	);

	it('refuses live responses and a client reference inconsistent with verified metadata', async () => {
		stub.transformNextResponse((session) => ({ ...session, livemode: true }));
		await expect(provider.create(requestBody(), randomUUID())).rejects.toMatchObject({
			code: 'PROVIDER_MODE_MISMATCH',
		});
		stub.transformNextResponse((session) => ({ ...session, client_reference_id: randomUUID() }));
		await expect(provider.create(requestBody(), randomUUID())).rejects.toMatchObject({
			code: 'PROVIDER_REFERENCE_MISMATCH',
		});
	});

	it.each([
		'javascript:alert(1)',
		'https://other.example.test/pay',
		'https://checkout.stripe.com:4242/pay',
		'https://user@checkout.stripe.com/pay',
	])('rejects an unsafe Checkout URL: case %#', async (url) => {
		stub.transformNextResponse((session) => ({ ...session, url }));
		await expect(provider.create(requestBody(), randomUUID())).rejects.toMatchObject({
			code: 'PROVIDER_INVALID_CONFIRMATION',
		});
	});

	it('rejects mismatching GET IDs and path components', async () => {
		const created = await provider.create(requestBody(), randomUUID());
		stub.transformNextResponse((session) => ({ ...session, id: 'cs_test_other' }));
		await expect(provider.get(created.id)).rejects.toMatchObject({ code: 'PROVIDER_ID_MISMATCH' });
		const gets = stub.gets.length;
		await expect(provider.get('../checkout/sessions/other')).rejects.toMatchObject({
			code: 'PROVIDER_INVALID_ID',
		});
		expect(stub.gets).toHaveLength(gets);
	});

	it('retains an unknown accepted POST across the SDK reset retry and later reuses the same key/body', async () => {
		const key = randomUUID();
		const body = requestBody();
		const count = stub.creates.length;
		stub.loseNextCreateResponse();
		await expect(provider.create(body, key)).rejects.toMatchObject({
			code: 'PROVIDER_UNAVAILABLE',
		});
		expect(stub.creates.length - count).toBe(2);
		const retry = await provider.create(body, key);
		expect(stub.creates.at(-1)).toEqual(stub.creates[count]);
		expect([...stub.payments.values()].filter((session) => session.id === retry.id)).toHaveLength(
			1,
		);
	});

	it('models Stripe v1 caching of a first 500 result for the same idempotency key', async () => {
		const key = randomUUID();
		const body = requestBody();
		stub.failNextCreate(500);
		await expect(provider.create(body, key)).rejects.toMatchObject({ code: 'PROVIDER_HTTP_500' });
		await expect(provider.create(body, key)).rejects.toMatchObject({ code: 'PROVIDER_HTTP_500' });
		expect(stub.creates.at(-1)).toEqual(stub.creates.at(-2));
	});

	it('bounds a held accepted request and budgets for the SDK closed-connection retry', async () => {
		const bounded = makeProvider({ PAYMENT_HTTP_TIMEOUT_MS: 100 });
		expect(bounded.httpTimeoutMs()).toBe(1200);
		const held = stub.holdNextCreate();
		const call = expect(bounded.create(requestBody(), randomUUID())).rejects.toMatchObject({
			code: 'PROVIDER_UNAVAILABLE',
		});
		const external = await held.ready;
		try {
			await call;
			expect(stub.payments.has(external.payment.id)).toBe(true);
		} finally {
			held.release();
		}
	});

	it('verifies the original signed bytes without issuing a GET from the signature boundary', () => {
		const event = signed();
		const gets = stub.gets.length;
		expect(provider.verifyWebhook(event.raw, event.signature)).toEqual({
			eventId: 'evt_test_task8',
			eventType: 'checkout.session.completed',
			sessionId: 'cs_test_signedsession',
		});
		expect(stub.gets).toHaveLength(gets);
		const reformatted = Buffer.from(JSON.stringify(JSON.parse(event.raw.toString('utf8'))));
		expect(() => provider.verifyWebhook(reformatted, event.signature)).toThrow(BadRequestException);
	});

	it('rejects wrong secret, missing raw bytes/header and expired signature timestamps', () => {
		const wrong = signed({}, 'whsec_wrong');
		expect(() => provider.verifyWebhook(wrong.raw, wrong.signature)).toThrow(BadRequestException);
		const event = signed();
		expect(() => provider.verifyWebhook(undefined, event.signature)).toThrow(BadRequestException);
		expect(() => provider.verifyWebhook(event.raw, undefined)).toThrow(BadRequestException);
		const old = signed({}, webhookSecret, Math.floor(Date.now() / 1000) - 600);
		expect(() => provider.verifyWebhook(old.raw, old.signature)).toThrow(BadRequestException);
	});

	it('ignores unsupported signed event types and rejects live or malformed Checkout events', () => {
		const unrelated = signed({ type: 'invoice.created' });
		expect(provider.verifyWebhook(unrelated.raw, unrelated.signature)).toBeNull();
		const live = signed({ livemode: true });
		expect(() => provider.verifyWebhook(live.raw, live.signature)).toThrow(BadRequestException);
		const wrongId = signed({
			data: { object: { id: 'cs_live_other', object: 'checkout.session' } },
		});
		expect(() => provider.verifyWebhook(wrongId.raw, wrongId.signature)).toThrow(
			BadRequestException,
		);
	});

	it.each([null, undefined, {}])(
		'rejects a signed Checkout envelope with malformed data: case %#',
		(data) => {
			const event = signed({ data });
			expect(() => provider.verifyWebhook(event.raw, event.signature)).toThrow(BadRequestException);
		},
	);
});
