/* global Response */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout, clearTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const directoryPath = path.dirname(fileURLToPath(import.meta.url));
const nativeRequire = createRequire(import.meta.url);

// Load the actual frontend modules without adding a second browser/test framework.
const modules = new Map();
function load(relative) {
	let filename = path.resolve(directoryPath, '..', relative);
	if (!path.extname(filename)) {
		filename = fs.existsSync(filename + '.ts') ? filename + '.ts' : path.join(filename, 'index.ts');
	}
	if (modules.has(filename)) return modules.get(filename).exports;
	const source = fs
		.readFileSync(filename, 'utf8')
		.replace('import.meta.env.VITE_API_URL', "'http://controlled.test'");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	}).outputText;
	const mod = { exports: {} };
	modules.set(filename, mod);
	const localRequire = (name) =>
		name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : nativeRequire(name);
	vm.runInThisContext(`(function(require,module,exports){${output}\n})`, { filename })(
		localRequire,
		mod,
		mod.exports,
	);
	return mod.exports;
}

const { readPaymentAttempt, savePaymentAttempt } = load(
	'src/features/payments/model/payment-attempt.ts',
);
const {
	paymentStatusLabel,
	confirmationLink,
	mergePaymentSnapshot,
	canReconcilePayment,
	paymentAmount,
	paymentProviderLabel,
	canUsePaymentProvider,
	canStartAnotherPayment,
	parsePaymentCapabilities,
} = load('src/features/payments/model/payment.ts');
const { startPaymentPolling } = load('src/features/payments/model/poll-payment.ts');
const { startPaymentEvents } = load('src/features/payments/model/stream-payment.ts');
const { ApiError } = load('src/shared/api/client.ts');

const attempt = { key: 'edc971dd-97ad-477e-8dce-880781393427', paymentId: null };
const pending = {
	id: '624f8a5e-3089-442a-a98f-bf86bb25abe1',
	workspaceId: 'workspace-a',
	purpose: 'WORKSPACE_DEMO',
	provider: 'stripe',
	amountMinor: 1_000,
	currency: 'USD',
	status: 'PENDING',
	confirmationUrl: 'https://checkout.stripe.com/c/pay/test_fixture',
	needsReview: false,
	lastErrorCode: null,
	createdAt: '2026-11-15T00:00:00.000Z',
	updatedAt: '2026-11-15T00:00:00.000Z',
};
const providerCapabilities = {
	enabled: true,
	provider: 'stripe',
	amountMinor: 1_000,
	currency: 'USD',
};

function memoryStorage() {
	const stored = new Map();
	return {
		getItem: (key) => stored.get(key) ?? null,
		setItem: (key, value) => stored.set(key, value),
	};
}

function poll(loadPayment, options = {}) {
	let count = 0;
	const seen = [];
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('Polling did not finish')), 10_000);
		startPaymentPolling({
			intervalMs: 1,
			maxDurationMs: 5_000,
			...options,
			load: async (signal) => {
				count += 1;
				return loadPayment(count, signal);
			},
			onPayment: (payment) => seen.push(payment),
			onStop: (reason, error) => {
				clearTimeout(timeout);
				resolve({ count, seen, reason, error });
			},
		});
	});
}

test('attempt survives reload when create response was lost', () => {
	const storage = memoryStorage();
	savePaymentAttempt(storage, 'user-a', 'workspace-a', attempt);
	assert.deepEqual(readPaymentAttempt(storage, 'user-a', 'workspace-a'), attempt);
});

test('local payment ID and original attempt key survive reload', () => {
	const storage = memoryStorage();
	const received = { ...attempt, paymentId: pending.id };
	savePaymentAttempt(storage, 'user-a', 'workspace-a', received);
	assert.deepEqual(readPaymentAttempt(storage, 'user-a', 'workspace-a'), received);
});

test('saved attempt is isolated by both user and workspace', () => {
	const storage = memoryStorage();
	savePaymentAttempt(storage, 'user-a', 'workspace-a', attempt);
	assert.equal(readPaymentAttempt(storage, 'user-b', 'workspace-a'), null);
	assert.equal(readPaymentAttempt(storage, 'user-a', 'workspace-b'), null);
});

test('storage failure propagates before an attempt can be dispatched', () => {
	assert.throws(() =>
		savePaymentAttempt(
			{
				getItem: () => null,
				setItem: () => {
					throw new Error('storage denied');
				},
			},
			'user-a',
			'workspace-a',
			attempt,
		),
	);
});

test('malformed stored attempt is rejected instead of silently replacing its key', () => {
	const storage = { getItem: () => '{"key":"wrong","paymentId":null}', setItem: () => {} };
	assert.throws(() => readPaymentAttempt(storage, 'user-a', 'workspace-a'));
});

test('unconfirmed/review payments and non-HTTPS URLs cannot open checkout', () => {
	assert.equal(confirmationLink({ ...pending, status: 'CREATED' }, providerCapabilities), null);
	assert.equal(confirmationLink({ ...pending, needsReview: true }, providerCapabilities), null);
	assert.equal(confirmationLink({ ...pending, confirmationUrl: null }, providerCapabilities), null);
	assert.equal(
		confirmationLink({ ...pending, confirmationUrl: 'javascript:alert(1)' }, providerCapabilities),
		null,
	);
	assert.equal(confirmationLink(pending, providerCapabilities), pending.confirmationUrl);
});

test('a Stripe payment can open only the configured Stripe Checkout origin', () => {
	for (const confirmationUrl of [
		'https://checkout.stripe.com.example.test/payment',
		'https://checkout.stripe.com:8443/payment',
	]) {
		assert.equal(confirmationLink({ ...pending, confirmationUrl }, providerCapabilities), null);
	}
});

test('price formatting uses the supplied currency for current and historical payments', () => {
	assert.equal(paymentAmount(providerCapabilities), '$10');
	assert.equal(paymentAmount({ amountMinor: 1_099, currency: 'USD' }), '$10.99');
	assert.equal(
		paymentAmount({ amountMinor: 10_000, currency: 'RUB' }).replace(/\s/g, ' '),
		'100 ₽',
	);
	assert.equal(paymentProviderLabel('stripe'), 'Stripe');
	assert.equal(paymentProviderLabel('yookassa'), 'ЮKassa');
	assert.equal(paymentProviderLabel(undefined), 'платёжный сервис');
});

test('historical provider payment cannot open checkout or reconcile through the active provider', () => {
	const legacy = {
		...pending,
		provider: 'yookassa',
		currency: 'RUB',
		amountMinor: 10_000,
		confirmationUrl: 'https://yoomoney.ru/checkout/legacy',
	};
	assert.equal(canUsePaymentProvider(legacy, providerCapabilities), false);
	assert.equal(confirmationLink(legacy, providerCapabilities), null);
	assert.equal(canStartAnotherPayment(legacy, providerCapabilities), true);
	assert.equal(legacy.status, 'PENDING');
	assert.equal(canStartAnotherPayment(pending, providerCapabilities), false);
	assert.equal(canUsePaymentProvider(pending, { ...providerCapabilities, enabled: false }), false);
	assert.equal(confirmationLink(pending, { ...providerCapabilities, enabled: false }), null);
});

test('invalid provider or price metadata cannot enable a payment action', () => {
	for (const override of [
		{ provider: 'unknown' },
		{ amountMinor: -1 },
		{ amountMinor: 10.5 },
		{ amountMinor: Number.MAX_SAFE_INTEGER + 1 },
		{ currency: 'UNKNOWN' },
		{ enabled: 'true' },
	]) {
		assert.throws(() => parsePaymentCapabilities({ ...providerCapabilities, ...override }));
	}
	assert.throws(() => parsePaymentCapabilities({ enabled: true }));
});

test('only confirmed backend success is labelled paid', () => {
	assert.equal(paymentStatusLabel({ ...pending, status: 'CREATED' }), 'Уточняем создание платежа');
	assert.equal(paymentStatusLabel({ ...pending, status: 'SUCCEEDED' }), 'Оплачено');
	assert.notEqual(paymentStatusLabel({ ...pending, needsReview: true }), 'Оплачено');
});

test('late nonterminal response cannot replace known success', () => {
	const success = { ...pending, status: 'SUCCEEDED', updatedAt: '2026-11-15T00:00:01.000Z' };
	assert.equal(mergePaymentSnapshot(success, pending).status, 'SUCCEEDED');
});

test('manual reconciliation is available for terminal payments that require review', () => {
	assert.equal(canReconcilePayment({ ...pending, status: 'SUCCEEDED', needsReview: true }), true);
	assert.equal(canReconcilePayment({ ...pending, status: 'SUCCEEDED', needsReview: false }), false);
	assert.equal(canReconcilePayment(pending), true);
});

test('terminal status stops polling after the first request', async () => {
	const result = await poll(async () => ({ ...pending, status: 'SUCCEEDED' }));
	assert.equal(result.reason, 'terminal');
	assert.equal(result.count, 1);
});

test('pending then verified success stops polling', async () => {
	const result = await poll(async (count) => ({
		...pending,
		status: count === 1 ? 'PENDING' : 'SUCCEEDED',
	}));
	assert.equal(result.reason, 'terminal');
	assert.equal(result.count, 2);
});

test('manual-review state stops polling', async () => {
	const result = await poll(async () => ({ ...pending, needsReview: true }));
	assert.equal(result.reason, 'review');
	assert.equal(result.count, 1);
});

test('network error pauses polling instead of repeating indefinitely', async () => {
	const result = await poll(async () => {
		throw new Error('controlled failure');
	});
	assert.equal(result.reason, 'error');
	assert.equal(result.count, 1);
});

test('maximum request count bounds polling', async () => {
	const result = await poll(async () => pending, { maxAttempts: 2 });
	assert.equal(result.reason, 'limit');
	assert.equal(result.count, 2);
});

test('unmount aborts the in-flight request and ignores its late response', async () => {
	let signal;
	let resolveRequest;
	let callbacks = 0;
	const cancel = startPaymentPolling({
		load: (nextSignal) => {
			signal = nextSignal;
			return new Promise((resolve) => (resolveRequest = resolve));
		},
		onPayment: () => callbacks++,
		onStop: () => callbacks++,
		maxDurationMs: 5_000,
	});
	cancel();
	assert.equal(signal.aborted, true);
	resolveRequest(pending);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(callbacks, 0);
});

test('hard deadline aborts a stalled request', async () => {
	let signal;
	const result = await poll(
		async (_count, nextSignal) => {
			signal = nextSignal;
			return new Promise(() => {});
		},
		{ maxDurationMs: 10 },
	);
	assert.equal(result.reason, 'limit');
	assert.equal(signal.aborted, true);
});

test('202 transport preserves response status and the attempt key', async () => {
	const originalFetch = globalThis.fetch;
	const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	let request;
	Object.defineProperty(globalThis, 'localStorage', {
		value: { getItem: () => null },
		configurable: true,
	});
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return new Response(JSON.stringify({ ...pending, status: 'CREATED', confirmationUrl: null }), {
			status: 202,
			headers: { 'Content-Type': 'application/json' },
		});
	};
	try {
		const { createPayment } = load('src/features/payments/api/payments.ts');
		const result = await createPayment('workspace-a', attempt.key);
		assert.equal(result.status, 202);
		assert.equal(result.data.status, 'CREATED');
		assert.equal(request.options.headers['Idempotency-Key'], attempt.key);
		assert.deepEqual(JSON.parse(request.options.body), { purpose: 'WORKSPACE_DEMO' });
	} finally {
		globalThis.fetch = originalFetch;
		if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
		else delete globalThis.localStorage;
	}
});

for (const scenario of [
	{ name: 'expired session', status: 401, path: '/workspaces/workspace-a', token: 'expired' },
	{ name: 'missing session', status: 401, path: '/workspaces/workspace-a', token: null },
	{ name: 'wrong login credentials', status: 401, path: '/auth/login', token: null },
	{
		name: 'insufficient permissions',
		status: 403,
		path: '/workspaces/workspace-a',
		token: 'valid',
	},
	{
		name: 'late rejection from the previous session',
		status: 401,
		path: '/workspaces/workspace-a',
		token: 'expired',
		refreshedToken: 'new-session',
	},
]) {
	test(`${scenario.name} preserves the payment attempt and handles sign-in correctly`, async () => {
		const originalFetch = globalThis.fetch;
		const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
		const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
		const savedAttempt = JSON.stringify(attempt);
		const stored = new Map([['payment-attempt', savedAttempt]]);
		if (scenario.token) stored.set('token', scenario.token);
		let redirect;
		Object.defineProperty(globalThis, 'localStorage', {
			value: { getItem: (key) => stored.get(key) ?? null, removeItem: (key) => stored.delete(key) },
			configurable: true,
		});
		Object.defineProperty(globalThis, 'window', {
			value: {
				location: {
					pathname: '/workspaces/workspace-a',
					search: '?tab=payments',
					hash: '#history',
					replace: (url) => (redirect = url),
				},
			},
			configurable: true,
		});
		let completeRequest;
		globalThis.fetch = () => new Promise((resolve) => (completeRequest = resolve));
		try {
			const { api, ApiError } = load('src/shared/api/client.ts');
			const request = api(scenario.path);
			if (scenario.refreshedToken) stored.set('token', scenario.refreshedToken);
			completeRequest(
				new Response(JSON.stringify({ message: 'Access denied' }), {
					status: scenario.status,
					headers: { 'Content-Type': 'application/json' },
				}),
			);
			await assert.rejects(request, (error) => {
				assert.ok(error instanceof ApiError);
				assert.equal(error.status, scenario.status);
				return true;
			});
			assert.equal(stored.get('payment-attempt'), savedAttempt);
			if (scenario.status === 401 && scenario.path !== '/auth/login' && !scenario.refreshedToken) {
				assert.equal(stored.has('token'), false);
				assert.equal(
					redirect,
					'/login?returnTo=%2Fworkspaces%2Fworkspace-a%3Ftab%3Dpayments%23history',
				);
			} else {
				assert.equal(redirect, undefined);
				assert.equal(stored.get('token') ?? null, scenario.refreshedToken ?? scenario.token);
			}
		} finally {
			globalThis.fetch = originalFetch;
			if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
			else delete globalThis.localStorage;
			if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
			else delete globalThis.window;
		}
	});
}

for (const enabled of [true, false]) {
	test(`payment availability enabled=${enabled} preserves the independent history array`, async () => {
		const originalFetch = globalThis.fetch;
		const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
		Object.defineProperty(globalThis, 'localStorage', {
			value: { getItem: () => null },
			configurable: true,
		});
		globalThis.fetch = async (url) =>
			new Response(
				JSON.stringify(
					url.endsWith('/capabilities') ? { ...providerCapabilities, enabled } : [pending],
				),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		try {
			const { getPaymentCapabilities, listPayments } = load(
				'src/features/payments/api/payments.ts',
			);
			const [capabilities, history] = await Promise.all([
				getPaymentCapabilities('workspace-a'),
				listPayments('workspace-a'),
			]);
			assert.deepEqual(capabilities, { ...providerCapabilities, enabled });
			assert.deepEqual(history, [pending]);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
			else delete globalThis.localStorage;
		}
	});
}

test('a failed availability request does not discard successful payment history', async () => {
	const originalFetch = globalThis.fetch;
	const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	Object.defineProperty(globalThis, 'localStorage', {
		value: { getItem: () => null },
		configurable: true,
	});
	globalThis.fetch = async (url) => {
		if (url.endsWith('/capabilities')) throw new Error('availability temporarily unavailable');
		return new Response(JSON.stringify([pending]), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};
	try {
		const { getPaymentCapabilities, listPayments } = load('src/features/payments/api/payments.ts');
		const [capabilities, history] = await Promise.allSettled([
			getPaymentCapabilities('workspace-a'),
			listPayments('workspace-a'),
		]);
		assert.equal(capabilities.status, 'rejected');
		assert.equal(history.status, 'fulfilled');
		assert.deepEqual(history.value, [pending]);
	} finally {
		globalThis.fetch = originalFetch;
		if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
		else delete globalThis.localStorage;
	}
});

const paymentFrame = (payment) => `event: payment\ndata: ${JSON.stringify(payment)}\n\n`;

function eventsResponse(frames, onCancel = () => {}) {
	const encoder = new globalThis.TextEncoder();
	return new Response(
		new globalThis.ReadableStream({
			start(controller) {
				for (const frame of frames) {
					controller.enqueue(typeof frame === 'string' ? encoder.encode(frame) : frame);
				}
				controller.close();
			},
			cancel: onCancel,
		}),
		{ headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
	);
}

function observeEvents(open, options = {}) {
	let count = 0;
	const seen = [];
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('SSE did not finish')), 5_000);
		startPaymentEvents({
			retryDelayMs: 1,
			maxDurationMs: 2_000,
			...options,
			open: (signal) => open(++count, signal),
			onPayment: (payment) => seen.push(payment),
			onStop: (reason, error) => {
				clearTimeout(timeout);
				resolve({ count, seen, reason, error });
			},
		});
	});
}

test('SSE handles UTF-8, CRLF split across chunks, multiline data and several frames', async () => {
	const success = { ...pending, status: 'SUCCEEDED', lastErrorCode: 'Проверено' };
	const frame =
		': connected\r\n\r\nevent: ignored\r\ndata: {}\r\n\r\n' +
		`event: payment\r\ndata: {\r\ndata: ${JSON.stringify(pending).slice(1, -1)}\r\ndata: }\r\n\r\n` +
		paymentFrame(success);
	const bytes = new globalThis.TextEncoder().encode(frame);
	const result = await observeEvents(async () =>
		eventsResponse([...bytes].map((byte) => new Uint8Array([byte]))),
	);
	assert.deepEqual(result.seen, [pending, success]);
	assert.equal(result.reason, 'terminal');
	assert.equal(result.count, 1);
});

test('SSE reconnect receives a fresh snapshot after a disconnected transition', async () => {
	const success = { ...pending, status: 'SUCCEEDED', updatedAt: '2026-11-18T10:00:00.000Z' };
	const result = await observeEvents(async (count) =>
		eventsResponse([paymentFrame(count === 1 ? pending : success)]),
	);
	assert.deepEqual(result.seen, [pending, success]);
	assert.equal(result.reason, 'terminal');
	assert.equal(result.count, 2);
});

test('SSE consumes coalesced frames and ignores data after a terminal snapshot', async () => {
	const success = { ...pending, status: 'SUCCEEDED' };
	const result = await observeEvents(async () =>
		eventsResponse([paymentFrame(pending) + paymentFrame(success) + paymentFrame(pending)]),
	);
	assert.deepEqual(result.seen, [pending, success]);
	assert.equal(result.count, 1);
	assert.equal(result.reason, 'terminal');
});

test('SSE discards an incomplete frame before reconnect instead of splicing connections', async () => {
	const success = { ...pending, status: 'SUCCEEDED' };
	const result = await observeEvents(async (count) =>
		eventsResponse([count === 1 ? paymentFrame(pending).slice(0, -1) : paymentFrame(success)]),
	);
	assert.deepEqual(result.seen, [success]);
	assert.equal(result.count, 2);
});

test('SSE closes its reader immediately on needsReview', async () => {
	let cancelled = false;
	const review = { ...pending, needsReview: true };
	const result = await observeEvents(async () => {
		const encoder = new globalThis.TextEncoder();
		return new Response(
			new globalThis.ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(paymentFrame(review)));
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ headers: { 'Content-Type': 'text/event-stream' } },
		);
	});
	assert.equal(result.reason, 'review');
	assert.equal(result.count, 1);
	assert.equal(cancelled, true);
});

test('SSE retries a closed stream at most twice', async () => {
	const result = await observeEvents(async () => eventsResponse([paymentFrame(pending)]));
	assert.equal(result.reason, 'error');
	assert.equal(result.count, 3);
});

for (const status of [401, 403, 404]) {
	test(`SSE never retries HTTP ${status}`, async () => {
		const result = await observeEvents(async () => {
			throw new ApiError('Access denied', status);
		});
		assert.equal(result.reason, 'error');
		assert.equal(result.error.status, status);
		assert.equal(result.count, 1);
	});
}

test('SSE does not reconnect after membership is revoked during an open stream', async () => {
	const result = await observeEvents(async () =>
		eventsResponse([paymentFrame(pending), 'event: payment-error\ndata: {"statusCode":404}\n\n']),
	);
	assert.equal(result.reason, 'error');
	assert.equal(result.error.status, 404);
	assert.deepEqual(result.seen, [pending]);
	assert.equal(result.count, 1);
});

test('SSE cancellation aborts the reader and prevents callbacks or reconnects', async () => {
	let signal;
	let cancelled = false;
	let opened = 0;
	let received = 0;
	let stopped = 0;
	let delivered;
	const first = new Promise((resolve) => (delivered = resolve));
	const cancel = startPaymentEvents({
		retryDelayMs: 1,
		open: async (nextSignal) => {
			signal = nextSignal;
			opened += 1;
			return new Response(
				new globalThis.ReadableStream({
					start(controller) {
						controller.enqueue(new globalThis.TextEncoder().encode(paymentFrame(pending)));
					},
					cancel() {
						cancelled = true;
					},
				}),
				{ headers: { 'Content-Type': 'text/event-stream' } },
			);
		},
		onPayment: () => {
			received += 1;
			delivered();
		},
		onStop: () => stopped++,
	});
	await first;
	cancel();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(signal.aborted, true);
	assert.equal(cancelled, true);
	assert.equal(opened, 1);
	assert.equal(received, 1);
	assert.equal(stopped, 0);
});

test('SSE cancellation ignores and cancels a late fetch response', async () => {
	let resolveOpen;
	let signal;
	let cancelled = false;
	let callbacks = 0;
	const cancel = startPaymentEvents({
		open: (nextSignal) => {
			signal = nextSignal;
			return new Promise((resolve) => (resolveOpen = resolve));
		},
		onPayment: () => callbacks++,
		onStop: () => callbacks++,
	});
	cancel();
	resolveOpen(
		new Response(
			new globalThis.ReadableStream({
				cancel() {
					cancelled = true;
				},
			}),
			{ headers: { 'Content-Type': 'text/event-stream' } },
		),
	);
	await Promise.resolve();
	assert.equal(signal.aborted, true);
	assert.equal(cancelled, true);
	assert.equal(callbacks, 0);
});

test('SSE cancellation clears a scheduled reconnect', async () => {
	let opened = 0;
	let callbacks = 0;
	const cancel = startPaymentEvents({
		open: async () => {
			opened += 1;
			throw new Error('offline');
		},
		retryDelayMs: 5,
		onPayment: () => callbacks++,
		onStop: () => callbacks++,
	});
	await Promise.resolve();
	cancel();
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.equal(opened, 1);
	assert.equal(callbacks, 0);
});

test('SSE deadline aborts a stalled connection without an endless retry', async () => {
	let signal;
	const result = await observeEvents(
		async (_count, nextSignal) => {
			signal = nextSignal;
			return new Promise(() => {});
		},
		{ maxDurationMs: 10 },
	);
	assert.equal(result.reason, 'limit');
	assert.equal(result.count, 1);
	assert.equal(signal.aborted, true);
});

test('SSE fetch carries Bearer auth in the header and no token in the URL', async () => {
	const originalFetch = globalThis.fetch;
	const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	const controller = new globalThis.AbortController();
	let request;
	Object.defineProperty(globalThis, 'localStorage', {
		value: { getItem: () => 'test-session' },
		configurable: true,
	});
	globalThis.fetch = async (url, options) => {
		request = { url, options };
		return eventsResponse([paymentFrame({ ...pending, status: 'SUCCEEDED' })]);
	};
	try {
		const { getPaymentEvents } = load('src/features/payments/api/payments.ts');
		await getPaymentEvents(pending.id, controller.signal);
		assert.equal(request.url, `http://controlled.test/payments/${pending.id}/events`);
		assert.equal(request.options.headers.Authorization, 'Bearer test-session');
		assert.equal(request.options.headers.Accept, 'text/event-stream');
		assert.equal(request.options.credentials, undefined);
		assert.equal(request.options.signal, controller.signal);
	} finally {
		globalThis.fetch = originalFetch;
		if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
		else delete globalThis.localStorage;
	}
});
