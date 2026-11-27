import '../src/instrumentation';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import * as Stripe from 'stripe';
import { AppModule } from '../src/app.module';
import { shutdownTelemetry } from '../src/instrumentation';
import { appLogger, configureObservability } from '../src/observability/http';
import { PaymentRecoveryService } from '../src/payments/payment-recovery.service';
import { STRIPE_API_BASE } from '../src/payments/stripe-payment.provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { createAppValidationPipe } from '../src/validation.pipe';
import { WorkerModule } from '../src/worker/worker.module';
import { StripeStub } from './task8-stripe-stub';

// Only print checks with a fixed description. Error objects and HTTP response bodies can contain credentials.
class SmokeCheck extends Error {}
function check(condition: unknown, description: string): asserts condition {
	if (!condition) throw new SmokeCheck(description);
}

const database = 'task9_observability_test';
const scheduledService = 'workspace-payment-worker-smoke';

async function verifyDatabase(prisma: PrismaService) {
	const [physical] = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
	check(physical?.name === database, 'physical Task 9 database');
}

async function scheduledRecovery(paymentId: string, stubBase: string) {
	check(/^http:\/\/127\.0\.0\.1:\d+$/.test(stubBase), 'loopback worker stub');
	const worker = await Test.createTestingModule({ imports: [WorkerModule] })
		.overrideProvider(STRIPE_API_BASE)
		.useValue(stubBase)
		.compile();
	try {
		worker.useLogger(appLogger);
		await verifyDatabase(worker.get(PrismaService));
		await worker.init();
		// Same call as PaymentMaintenanceService, limited to the payment reserved by this run.
		await worker.get(PaymentRecoveryService).recover(paymentId, new Date());
	} finally {
		await worker.close();
		await shutdownTelemetry();
	}
}

async function runScheduledWorker(paymentId: string, stubBase: string) {
	const { stdout } = await promisify(execFile)(
		process.execPath,
		[
			...process.execArgv.filter((arg) => !arg.startsWith('--inspect')),
			__filename,
			'scheduled',
			paymentId,
			stubBase,
		],
		{
			env: { ...process.env, OTEL_SERVICE_NAME: scheduledService },
			timeout: 60_000,
			maxBuffer: 512_000,
		},
	);
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.startsWith('{')) continue;
		const entry = JSON.parse(line) as Record<string, unknown>;
		if (
			entry.service !== scheduledService ||
			entry.operation !== 'payment.reconcile' ||
			entry.paymentId !== paymentId ||
			entry.source !== 'scheduled' ||
			entry.result !== 'verified'
		)
			continue;
		check(
			typeof entry.requestId === 'string' && /^[a-f0-9-]{36}$/.test(entry.requestId),
			'scheduled request ID',
		);
		check(
			typeof entry.traceId === 'string' &&
				/^[0-9a-f]{32}$/.test(entry.traceId) &&
				!/^0+$/.test(entry.traceId),
			'scheduled trace ID',
		);
		console.log(
			JSON.stringify({
				service: scheduledService,
				operation: 'payment.reconcile',
				source: 'scheduled',
				paymentId,
				result: 'verified',
				requestId: entry.requestId,
				traceId: entry.traceId,
			}),
		);
		return { step: 'scheduled', requestId: entry.requestId, traceId: entry.traceId };
	}
	throw new SmokeCheck('missing successful scheduled worker log');
}

async function* paymentEvents(response: Response) {
	check(response.headers.get('content-type')?.includes('text/event-stream'), 'SSE content type');
	check(response.body, 'SSE response stream');
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			let boundary: RegExpExecArray | null;
			while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
				const frame = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary[0].length);
				if (!/^event:\s*payment\s*$/m.test(frame)) continue;
				const data = /^data:\s*(.+)$/m.exec(frame);
				check(data, 'SSE payment data');
				const payment = JSON.parse(data[1]) as { id: string; status: string };
				yield { id: payment.id, status: payment.status };
			}
		}
	} finally {
		await reader.cancel();
	}
}

async function run() {
	const target = new URL(process.env.DATABASE_URL ?? 'about:blank');
	check(
		['postgres:', 'postgresql:'].includes(target.protocol) &&
			['postgres', 'localhost', '127.0.0.1'].includes(target.hostname) &&
			target.pathname === '/' + database &&
			(target.searchParams.get('schema') ?? 'public') === 'public',
		'dedicated Task 9 database URL',
	);
	if (process.argv[2] === 'scheduled') return scheduledRecovery(process.argv[3], process.argv[4]);

	const stub = new StripeStub('sk_test_' + randomBytes(20).toString('hex'));
	const signingSecret = 'whsec_' + randomBytes(20).toString('hex');
	Object.assign(process.env, {
		PAYMENT_MODE: 'test',
		STRIPE_SECRET_KEY: stub.apiKey,
		STRIPE_WEBHOOK_SECRET: signingSecret,
		PAYMENT_RETURN_BASE_URL: 'http://localhost:5173',
	});
	let app: INestApplication | undefined;
	try {
		await stub.start();
		const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(STRIPE_API_BASE)
			.useValue(stub.baseUrl)
			.compile();
		const prisma = moduleRef.get(PrismaService);
		await verifyDatabase(prisma);
		app = moduleRef.createNestApplication({ rawBody: true, logger: appLogger });
		configureObservability(app);
		app.useGlobalPipes(createAppValidationPipe());
		const traceIds = new Map<string, string>();
		app.use((req: Request, _res: ExpressResponse, next: NextFunction) => {
			const id = req.get('x-request-id');
			const active = trace.getActiveSpan()?.spanContext();
			if (id && active) traceIds.set(id, active.traceId);
			next();
		});
		await app.listen(0, '127.0.0.1');
		const base = await app.getUrl();
		const runId = randomUUID();
		const session: { token?: string } = {};
		const requestId = (step: string) => `tt9-${runId}-${step}`;
		const call = async (
			step: string,
			path: string,
			expected: number,
			options: RequestInit = {},
		) => {
			const headers = new Headers(options.headers);
			headers.set('x-request-id', requestId(step));
			if (session.token && !path.includes('/webhooks/'))
				headers.set('authorization', 'Bearer ' + session.token);
			if (options.body) headers.set('content-type', 'application/json');
			const response = await fetch(base + path, {
				...options,
				headers,
				redirect: 'error',
				signal: AbortSignal.timeout(25_000),
			});
			check(response.status === expected, `${step} HTTP ${response.status} (expected ${expected})`);
			check(response.headers.get('x-request-id') === requestId(step), step + ' request ID');
			return response;
		};
		const post = (body: object): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
		const password = randomBytes(24).toString('hex');
		const email = `tt9-${runId}@example.test`;
		await call(
			'register',
			'/auth/register',
			201,
			post({ name: 'Task 9', email, password, passwordConfirmation: password }),
		);
		const login = await call('login', '/auth/login', 200, post({ email, password }));
		session.token = ((await login.json()) as { accessToken: string }).accessToken;
		check(typeof session.token === 'string' && session.token.length > 0, 'login');
		const workspace = await call('workspace', '/workspaces', 201, post({ name: 'Task 9 smoke' }));
		const { id: workspaceId } = (await workspace.json()) as { id: string };

		// Emulate a trusted caller carrying a W3C vendor entry on the create request only.
		const upstream = randomBytes(16).toString('hex');
		const create = await call('create', `/workspaces/${workspaceId}/payments`, 201, {
			...post({ purpose: 'WORKSPACE_DEMO' }),
			headers: {
				'Idempotency-Key': randomUUID(),
				traceparent: `00-${upstream}-${randomBytes(8).toString('hex')}-01`,
				tracestate: 'tt9=smoke',
			},
		});
		const payment = (await create.json()) as { id: string; status: string };
		check(payment.status === 'PENDING' && stub.creates.length === 1, 'pending Checkout Session');
		const { providerPaymentId } = await prisma.payment.findUniqueOrThrow({
			where: { id: payment.id },
			select: { providerPaymentId: true },
		});
		check(providerPaymentId && stub.payments.has(providerPaymentId), 'persisted Stripe binding');
		const route = '/payments/' + payment.id;
		const reconciled = await call('reconcile', route + '/reconcile', 200, { method: 'POST' });
		check(
			((await reconciled.json()) as { status: string }).status === 'PENDING',
			'reconcile pending',
		);
		await prisma.payment.update({
			where: { id: payment.id, workspaceId, status: 'PENDING' },
			data: { nextReconcileAt: new Date(0) },
			select: { id: true },
		});
		const scheduled = await runScheduledWorker(payment.id, stub.baseUrl);
		const events = paymentEvents(await call('events', route + '/events', 200));
		try {
			const initial = await events.next();
			check(
				!initial.done && initial.value.id === payment.id && initial.value.status === 'PENDING',
				'initial SSE payment',
			);
			stub.change(providerPaymentId, { status: 'complete', payment_status: 'paid', url: null });
			const payload = JSON.stringify({
				id: 'evt_' + randomBytes(16).toString('hex'),
				type: 'checkout.session.completed',
				object: 'event',
				livemode: false,
				data: { object: { id: providerPaymentId, object: 'checkout.session' } },
			});
			await call('webhook', '/payments/webhooks/stripe', 200, {
				method: 'POST',
				body: payload,
				headers: {
					'Stripe-Signature': Stripe.webhooks.generateTestHeaderString({
						payload,
						secret: signingSecret,
					}),
				},
			});
			const final = await events.next();
			check(
				!final.done && final.value.id === payment.id && final.value.status === 'SUCCEEDED',
				'terminal SSE payment',
			);
			check((await events.next()).done, 'terminal stream completed');
		} finally {
			await events.return();
		}

		const saved = await prisma.payment.findUniqueOrThrow({
			where: { id: payment.id },
			select: { status: true },
		});
		check(
			saved.status === 'SUCCEEDED' && stub.gets.length === 3,
			'committed status and provider GETs',
		);
		const stages = ['create', 'reconcile', 'scheduled', 'webhook', 'events'];
		const traces = stages.map((step) => {
			if (step === 'scheduled') return scheduled;
			const id = requestId(step);
			const traceId = traceIds.get(id);
			check(traceId && /^[0-9a-f]{32}$/.test(traceId) && !/^0+$/.test(traceId), step + ' trace ID');
			return { step, requestId: id, traceId };
		});
		check(
			new Set(traces.map((stage) => stage.traceId)).size === stages.length,
			'independent inbound traces',
		);
		check(
			traces[0].traceId === upstream && stub.traceHeaders[0]?.tracestate === 'tt9=smoke',
			'W3C create carrier',
		);
		for (const [index, { traceId }] of traces.slice(0, 4).entries()) {
			check(stub.traceHeaders[index]?.traceparent?.split('-')[1] === traceId, 'W3C provider trace');
		}
		console.log(
			JSON.stringify({
				scenario: 'task9-payment-stub',
				paymentId: payment.id,
				status: saved.status,
				sse: ['PENDING', 'SUCCEEDED'],
				sdk: { post: stub.creates.length, get: stub.gets.length },
				traces,
			}),
		);
	} finally {
		await app?.close();
		await stub.close();
		await shutdownTelemetry();
	}
}

void run().catch((error: unknown) => {
	console.error(
		error instanceof SmokeCheck
			? error.message
			: 'Task 9 payment smoke failed; inspect correlated application logs',
	);
	process.exitCode = 1;
});
