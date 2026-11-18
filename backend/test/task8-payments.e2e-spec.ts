import * as Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient, WorkspaceRole } from '@prisma/client';
import * as request from 'supertest';
import { AuthenticatedRequest } from '../src/auth/authenticated-request';
import { JwtAuthGuard } from '../src/auth/decorators/jwt-auth.decorator';
import { PaymentMaintenanceService } from '../src/payments/payment-maintenance.service';
import { PaymentRecoveryService } from '../src/payments/payment-recovery.service';
import { PaymentWebhookService } from '../src/payments/payment-webhook.service';
import { PaymentsModule } from '../src/payments/payments.module';
import { PAYMENT_EVENTS_INTERVAL_MS, PaymentsService } from '../src/payments/payments.service';
import { STRIPE_API_BASE } from '../src/payments/stripe-payment.provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { createAppValidationPipe } from '../src/validation.pipe';
import { WorkspacesModule } from '../src/workspaces/workspaces.module';
import { isolatedConfig } from './test-config';
import { StubSession, StripeStub } from './task8-stripe-stub';

const describePayments = process.env.TASK8_PAYMENTS_E2E === 'true' ? describe : describe.skip;

function dedicatedDatabaseUrl(): string {
	const value = process.env.TASK8_PAYMENTS_DATABASE_URL;
	if (!value) throw new Error('TASK8_PAYMENTS_DATABASE_URL is required for Task 8 SQL tests');
	const target = new URL(value);
	if (
		!['postgres:', 'postgresql:'].includes(target.protocol) ||
		!['localhost', '127.0.0.1', 'postgres'].includes(target.hostname) ||
		target.port !== '5432' ||
		target.pathname !== '/task8_stripe_test' ||
		(target.searchParams.get('schema') ?? 'public') !== 'public' ||
		target.searchParams.getAll('schema').length > 1 ||
		[...target.searchParams.keys()].some((key) => !['schema', 'connection_limit'].includes(key))
	)
		throw new Error('Only the dedicated local task8_stripe_test database is allowed');
	return value;
}

interface PublicPayment {
	id: string;
	workspaceId: string;
	status: string;
	confirmationUrl: string | null;
	needsReview: boolean;
	lastErrorCode: string | null;
}

describePayments(
	'Task 8: real HTTP adapter, dedicated PostgreSQL and controlled provider faults',
	() => {
		const run = `task8-${randomUUID()}`;
		const ids = {
			owner: `${run}-owner`,
			secondOwner: `${run}-second-owner`,
			member: `${run}-member`,
			viewer: `${run}-viewer`,
			outsider: `${run}-outsider`,
			workspace: `${run}-workspace`,
			otherWorkspace: `${run}-other-workspace`,
		};
		const workspaces = [ids.workspace, ids.otherWorkspace];
		const users = [ids.owner, ids.secondOwner, ids.member, ids.viewer, ids.outsider];
		const config = isolatedConfig({
			PAYMENT_MODE: 'test',

			STRIPE_SECRET_KEY: 'sk_test_task8_key',
			STRIPE_WEBHOOK_SECRET: 'whsec_task8_test',
			PAYMENT_RETURN_BASE_URL: 'http://localhost:5173',
			PAYMENT_HTTP_TIMEOUT_MS: 2000,
			PAYMENT_RECONCILE_INTERVAL_MS: 60_000,
		});
		const stub = new StripeStub();
		let prisma: PrismaClient;
		let app: INestApplication;
		let recovery: PaymentRecoveryService;
		let webhooks: PaymentWebhookService;
		let databaseVerified = false;
		let pendingRelease: (() => void) | undefined;
		const auth = (id = ids.owner) => ({ 'x-task8-user-id': id });
		const post = (key: string = randomUUID(), user = ids.owner, workspace = ids.workspace) =>
			request(app.getHttpServer())
				.post(`/workspaces/${workspace}/payments`)
				.set(auth(user))
				.set('Idempotency-Key', key)
				.send({ purpose: 'WORKSPACE_DEMO' });
		const create = async (
			key: string = randomUUID(),
			user = ids.owner,
			workspace = ids.workspace,
		) => {
			const response = await post(key, user, workspace).expect(201);
			return response.body as PublicPayment;
		};
		const stored = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
		const signedWebhook = (payload: string, signature?: string) =>
			request(app.getHttpServer())
				.post('/payments/webhooks/stripe')
				.set('Content-Type', 'application/json')
				.set(
					'Stripe-Signature',
					signature ??
						Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_task8_test' }),
				)
				.send(payload);
		const webhookPayload = (id: string, event = 'checkout.session.completed') =>
			JSON.stringify({
				id: 'evt_' + randomUUID().replace(/-/g, ''),
				object: 'event',
				livemode: false,
				type: event,
				data: { object: { id, object: 'checkout.session' } },
			});
		const webhook = (id: string, event = 'checkout.session.completed') =>
			signedWebhook(webhookPayload(id, event));
		const eventKey = (providerObjectId: string) => ({
			provider_eventType_providerObjectId: {
				provider: 'stripe',
				eventType: 'checkout.session.completed',
				providerObjectId,
			},
		});
		const reconcile = (id: string, user = ids.owner) =>
			request(app.getHttpServer()).post(`/payments/${id}/reconcile`).set(auth(user));
		const providerId = async (localId: string) => {
			const row = await stored(localId);
			if (!row.providerPaymentId) throw new Error('Fixture provider ID was not saved');
			return row.providerPaymentId;
		};
		const makeDue = async (id: string) =>
			prisma.payment.update({
				where: { id },
				data: { createdAt: new Date(Date.now() - 180_000), nextReconcileAt: new Date(0) },
			});

		beforeAll(async () => {
			prisma = new PrismaClient({ datasources: { db: { url: dedicatedDatabaseUrl() } } });
			await prisma.$connect();
			const [target] = await prisma.$queryRaw<Array<{ database: string }>>`
			SELECT current_database() AS database
		`;
			if (target.database !== 'task8_stripe_test') throw new Error('Unexpected physical test DB');
			databaseVerified = true;
			await prisma.user.createMany({
				data: users.map((id) => ({
					id,
					email: `${id}@example.test`,
					name: 'Task 8 test',
					password: 'unused-test-only',
				})),
			});
			await prisma.workspace.createMany({
				data: workspaces.map((id) => ({ id, name: 'Task 8 test' })),
			});
			await prisma.workspaceMember.createMany({
				data: [
					{ userId: ids.owner, workspaceId: ids.workspace, role: WorkspaceRole.OWNER },
					{ userId: ids.owner, workspaceId: ids.otherWorkspace, role: WorkspaceRole.OWNER },
					{ userId: ids.secondOwner, workspaceId: ids.workspace, role: WorkspaceRole.OWNER },
					{ userId: ids.member, workspaceId: ids.workspace, role: WorkspaceRole.MEMBER },
					{ userId: ids.viewer, workspaceId: ids.workspace, role: WorkspaceRole.VIEWER },
				],
			});
			await stub.start();
			const module = await Test.createTestingModule({
				imports: [
					ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
					PaymentsModule,
					WorkspacesModule,
				],
			})
				.overrideProvider(ConfigService)
				.useValue(config)
				.overrideProvider(PrismaService)
				.useValue(prisma)
				.overrideProvider(STRIPE_API_BASE)
				.useValue(stub.baseUrl)
				.overrideGuard(JwtAuthGuard)
				.useValue({
					canActivate(context: ExecutionContext) {
						const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
						const userId = req.headers['x-task8-user-id'];
						if (typeof userId !== 'string' || !users.includes(userId))
							throw new UnauthorizedException();
						req.user = { sub: userId, email: `${userId}@example.test` };
						return true;
					},
				})
				.compile();
			app = module.createNestApplication({ logger: false, rawBody: true });
			app.useGlobalPipes(createAppValidationPipe());
			await app.init();
			recovery = module.get(PaymentRecoveryService);
			webhooks = module.get(PaymentWebhookService);
		});
		const maintenance = () =>
			new PaymentMaintenanceService(recovery, webhooks, prisma as PrismaService, config);
		const insertLocal = async (base: Awaited<ReturnType<typeof stored>>, id: string) => {
			const body = base.providerRequest as Prisma.InputJsonObject;
			return prisma.payment.create({
				data: {
					id,
					workspaceId: ids.workspace,
					userId: ids.owner,
					purpose: 'WORKSPACE_DEMO',
					amountMinor: 1000,
					currency: 'USD',
					idempotencyKey: randomUUID(),
					requestHash: base.requestHash,
					providerIdempotenceKey: randomUUID(),
					provider: 'stripe',
					providerRequest: {
						...body,
						client_reference_id: id,
						metadata: { paymentId: id, workspaceId: ids.workspace },
					},
				},
			});
		};

		afterEach(() => {
			pendingRelease?.();
			pendingRelease = undefined;
			stub.resetFaults();
		});

		afterAll(async () => {
			pendingRelease?.();
			await app?.close();
			await stub.close();
			if (databaseVerified) {
				await prisma.paymentEvent.deleteMany({
					where: {
						OR: [
							{ providerObjectId: { in: [...stub.payments.keys()] } },
							{ payment: { workspaceId: { in: workspaces } } },
						],
					},
				});
				await prisma.paymentAudit.deleteMany({
					where: { payment: { workspaceId: { in: workspaces } } },
				});
				await prisma.payment.deleteMany({ where: { workspaceId: { in: workspaces } } });
				await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaces } } });
				await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
				await prisma.user.deleteMany({ where: { id: { in: users } } });
			}
			await prisma?.$disconnect();
		});

		it('rejects a bad signature before fetching Stripe or recording an event', async () => {
			const gets = stub.gets.length;
			const events = await prisma.paymentEvent.count();
			await signedWebhook(webhookPayload('cs_test_unsigned'), 't=1,v1=invalid').expect(400);
			expect(stub.gets).toHaveLength(gets);
			expect(await prisma.paymentEvent.count()).toBe(events);
		});

		it('ignores an unrelated signed event without a provider lookup', async () => {
			const gets = stub.gets.length;
			await signedWebhook(webhookPayload('cs_test_unrelated', 'customer.created')).expect(200);
			expect(stub.gets).toHaveLength(gets);
		});

		it('keeps legacy YooKassa records read-only and excludes them from Stripe recovery', async () => {
			const legacy = await create();
			await prisma.payment.update({
				where: { id: legacy.id },
				data: { provider: 'yookassa', confirmationUrl: 'https://yoomoney.ru/legacy-checkout' },
			});
			const gets = stub.gets.length;
			const creates = stub.creates.length;
			const result = await request(app.getHttpServer())
				.get('/payments/' + legacy.id)
				.set(auth())
				.expect(200);
			expect(result.body).toMatchObject({ provider: 'yookassa', confirmationUrl: null });
			await reconcile(legacy.id).expect(409);
			await recovery.recover(legacy.id);
			await makeDue(legacy.id);
			await maintenance().runOnce();
			expect(stub.gets).toHaveLength(gets);
			expect(stub.creates).toHaveLength(creates);
		});

		it('20 concurrent requests reserve one row and send one create; replay returns the same payment', async () => {
			const key = randomUUID();
			const before = stub.creates.length;
			const held = stub.holdNextCreate();
			pendingRelease = held.release;
			const leader = post(key).then((response) => response);
			await held.ready;
			const followers = await Promise.all(
				Array.from({ length: 19 }, () => post(key).then((response) => response)),
			);
			expect(followers.every((response) => response.status === 202)).toBe(true);
			held.release();
			const first = await leader;
			expect(first.status).toBe(201);
			const id = (first.body as PublicPayment).id;
			expect(new Set(followers.map((response) => (response.body as PublicPayment).id))).toEqual(
				new Set([id]),
			);
			expect(
				await prisma.payment.count({ where: { userId: ids.owner, idempotencyKey: key } }),
			).toBe(1);
			expect(stub.creates.length - before).toBe(1);
			const replay = await post(key).expect(200);
			expect(replay.body).toMatchObject({
				id,
				status: 'PENDING',
				amountMinor: 1000,
				currency: 'USD',
			});
			expect(stub.creates.length - before).toBe(1);
			for (const privateField of [
				'providerRequest',
				'providerIdempotenceKey',
				'requestHash',
				'leaseToken',
				'idempotencyKey',
			]) {
				expect(replay.body).not.toHaveProperty(privateField);
			}
		});

		it('includes workspace in request identity and isolates provider keys by user', async () => {
			const key = randomUUID();
			const first = await create(key);
			await post(key, ids.owner, ids.otherWorkspace).expect(409);
			const second = await create(key, ids.secondOwner);
			const rows = await prisma.payment.findMany({ where: { id: { in: [first.id, second.id] } } });
			expect(new Set(rows.map((row) => row.providerIdempotenceKey)).size).toBe(2);
			expect(new Set(rows.map((row) => row.providerPaymentId)).size).toBe(2);
		});

		it('applies an early verified webhook and never regresses to the late create pending snapshot', async () => {
			const held = stub.holdNextCreate();
			pendingRelease = held.release;
			const creating = post().then((response) => response);
			const { payment } = await held.ready;
			stub.change(payment.id, { status: 'complete', payment_status: 'paid' });
			await webhook(payment.id).expect(200);
			expect(await stored(payment.metadata.paymentId)).toMatchObject({
				status: 'SUCCEEDED',
				providerPaymentId: payment.id,
			});
			held.release(payment);
			const response = await creating;
			expect(response.status).toBe(201);
			expect(response.body).toMatchObject({ id: payment.metadata.paymentId, status: 'SUCCEEDED' });
			await webhook(payment.id).expect(200);
			await webhook(payment.id, 'checkout.session.expired').expect(200);
			expect(
				await prisma.paymentAudit.count({
					where: { paymentId: payment.metadata.paymentId, toStatus: 'SUCCEEDED' },
				}),
			).toBe(1);
		});

		it('keeps completed-but-unpaid pending without reopening an obsolete checkout link', async () => {
			const local = await create();
			const external = await providerId(local.id);
			stub.change(external, { status: 'complete', payment_status: 'unpaid', url: null });
			await webhook(external).expect(200);
			expect(await stored(local.id)).toMatchObject({ status: 'PENDING', confirmationUrl: null });
			const response = await request(app.getHttpServer())
				.get(`/payments/${local.id}`)
				.set(auth())
				.expect(200);
			expect(response.body).toMatchObject({ status: 'PENDING', confirmationUrl: null });
			stub.change(external, { status: 'complete', payment_status: 'paid' });
			await webhook(external).expect(200);
			expect((await stored(local.id)).status).toBe('SUCCEEDED');
		});

		it('rechecks the same event after a nonterminal snapshot instead of poisoning deduplication', async () => {
			const local = await create();
			const external = await providerId(local.id);
			await webhook(external).expect(200);
			expect(await stored(local.id)).toMatchObject({ status: 'PENDING' });
			stub.change(external, { status: 'complete', payment_status: 'paid' });
			await webhook(external).expect(200);
			await webhook(external).expect(200);
			expect(await stored(local.id)).toMatchObject({ status: 'SUCCEEDED' });
			expect(
				await prisma.paymentAudit.count({ where: { paymentId: local.id, toStatus: 'SUCCEEDED' } }),
			).toBe(1);
		});

		it('uses the current canceled snapshot rather than an untrusted succeeded event label', async () => {
			const local = await create();
			const external = await providerId(local.id);
			stub.change(external, { status: 'expired', payment_status: 'unpaid' });
			await webhook(external).expect(200);
			await webhook(external, 'checkout.session.expired').expect(200);
			expect((await stored(local.id)).status).toBe('CANCELLED');
			expect(
				await prisma.paymentAudit.count({ where: { paymentId: local.id, toStatus: 'CANCELLED' } }),
			).toBe(1);
			stub.change(external, { status: 'complete', payment_status: 'paid' });
			await webhook(external).expect(200);
			expect(await stored(local.id)).toMatchObject({
				status: 'CANCELLED',
				needsReview: true,
				lastErrorCode: 'PROVIDER_TERMINAL_CONFLICT',
			});
			expect(
				await prisma.paymentAudit.count({ where: { paymentId: local.id, toStatus: 'SUCCEEDED' } }),
			).toBe(0);
		});

		it('cannot replace a provider ID already bound to another local payment', async () => {
			const first = await create();
			const second = await create();
			const firstExternal = await providerId(first.id);
			const secondExternal = await providerId(second.id);
			stub.change(secondExternal, {
				status: 'complete',
				payment_status: 'paid',
				metadata: { paymentId: first.id, workspaceId: ids.workspace },
			});
			await webhook(secondExternal).expect(200);
			expect(await stored(first.id)).toMatchObject({
				status: 'PENDING',
				providerPaymentId: firstExternal,
			});
			expect(await stored(second.id)).toMatchObject({
				status: 'PENDING',
				providerPaymentId: secondExternal,
			});
		});

		it('maintenance revisits a nonterminal event even without another webhook delivery', async () => {
			const local = await create();
			const external = await providerId(local.id);
			await webhook(external).expect(200);
			stub.change(external, { status: 'complete', payment_status: 'paid' });
			await prisma.payment.update({
				where: { id: local.id },
				data: { nextReconcileAt: new Date(Date.now() + 86_400_000) },
			});
			await prisma.paymentEvent.update({
				where: eventKey(external),
				data: { nextReconcileAt: new Date(0) },
			});
			await maintenance().runOnce();
			expect((await stored(local.id)).status).toBe('SUCCEEDED');
			expect(
				await prisma.paymentEvent.findFirst({ where: { providerObjectId: external } }),
			).toMatchObject({ result: 'APPLIED' });
			expect(
				await prisma.paymentAudit.count({ where: { paymentId: local.id, toStatus: 'SUCCEEDED' } }),
			).toBe(1);
		});

		it.each([
			['live mode', (snapshot: StubSession) => ({ ...snapshot, livemode: true })],
			[
				'client reference',
				(snapshot: StubSession) => ({
					...snapshot,
					client_reference_id: randomUUID(),
				}),
			],
			[
				'amount',
				(snapshot: StubSession) => ({
					...snapshot,
					amount_total: 999,
				}),
			],
			[
				'currency',
				(snapshot: StubSession) => ({
					...snapshot,
					currency: 'eur',
				}),
			],
			[
				'workspace metadata',
				(snapshot: StubSession) => ({
					...snapshot,
					metadata: { ...snapshot.metadata, workspaceId: ids.otherWorkspace },
				}),
			],
		])('does not accept a terminal snapshot with invalid %s', async (_name, transform) => {
			const local = await create();
			const external = await providerId(local.id);
			stub.change(external, { status: 'complete', payment_status: 'paid' });
			stub.transformNextResponse(transform);
			await webhook(external).expect(200);
			expect((await stored(local.id)).status).toBe('PENDING');
			expect(
				await prisma.paymentAudit.count({ where: { paymentId: local.id, toStatus: 'SUCCEEDED' } }),
			).toBe(0);
		});

		it('returns 503 for a transient verification failure, then handles a provider retry', async () => {
			const local = await create();
			const external = await providerId(local.id);
			stub.change(external, { status: 'complete', payment_status: 'paid' });
			stub.failNextGet();
			await webhook(external).expect(503);
			expect((await stored(local.id)).status).toBe('PENDING');
			await webhook(external).expect(200);
			expect((await stored(local.id)).status).toBe('SUCCEEDED');
		});

		it('returns 503 when it cannot persist the webhook retry', async () => {
			const local = await create();
			const external = await providerId(local.id);
			stub.change(external, { status: 'complete', payment_status: 'paid' });
			stub.failNextGet();
			const eventWrite = jest
				.spyOn(prisma, '$queryRaw')
				.mockRejectedValueOnce(new Error('Event storage unavailable'));
			try {
				const response = await webhook(external).expect(503);
				expect(response.body.code).toBe('PAYMENT_VERIFICATION_UNAVAILABLE');
				expect((await stored(local.id)).status).toBe('PENDING');
				expect(await prisma.paymentEvent.findUnique({ where: eventKey(external) })).toBeNull();
			} finally {
				eventWrite.mockRestore();
			}
			await webhook(external).expect(200);
			expect((await stored(local.id)).status).toBe('SUCCEEDED');
		});

		it('does not reclaim a webhook event that was rescheduled after its batch was selected', async () => {
			const local = await create();
			const external = await providerId(local.id);
			await webhook(external).expect(200);
			const event = await prisma.paymentEvent.update({
				where: eventKey(external),
				data: { nextReconcileAt: new Date(Date.now() + 60_000) },
			});
			const staleBatch = prisma.paymentEvent.findMany({ where: { id: event.id } });
			const select = jest.spyOn(prisma.paymentEvent, 'findMany').mockReturnValueOnce(staleBatch);
			const gets = stub.gets.filter((id) => id === external).length;
			try {
				await maintenance().runOnce();
				expect(stub.gets.filter((id) => id === external)).toHaveLength(gets);
				expect(await prisma.paymentEvent.findUnique({ where: { id: event.id } })).toEqual(event);
			} finally {
				select.mockRestore();
			}
		});

		it('returns 503 for checkout replay while keeping the payment visible in history', async () => {
			const key = randomUUID();
			const local = await create(key);
			const creates = stub.creates.length;
			jest.mocked(config.get).mockReturnValueOnce(undefined);
			const response = await post(key).expect(503);
			expect(response.body.code).toBe('PAYMENT_NOT_CONFIGURED');
			expect(stub.creates).toHaveLength(creates);
			await request(app.getHttpServer()).get(`/payments/${local.id}`).set(auth()).expect(200);
		});

		it('durably records UNMATCHED and can apply its later delivery after the local record becomes available', async () => {
			const base = await stored((await create()).id);
			const id = randomUUID();
			const external = 'cs_test_' + randomUUID().replace(/-/g, '');
			const template = stub.payments.get(base.providerPaymentId!)!;
			stub.add({
				...template,
				id: external,
				status: 'complete',
				payment_status: 'paid',
				client_reference_id: id,
				metadata: { paymentId: id, workspaceId: ids.workspace },
			});
			await webhook(external).expect(200);
			expect(
				await prisma.paymentEvent.findFirst({ where: { providerObjectId: external } }),
			).toMatchObject({ result: 'UNMATCHED' });
			await insertLocal(base, id);
			await webhook(external).expect(200);
			expect(await stored(id)).toMatchObject({ status: 'SUCCEEDED', providerPaymentId: external });
			expect(
				await prisma.paymentAudit.count({ where: { paymentId: id, toStatus: 'SUCCEEDED' } }),
			).toBe(1);
		});

		it('maintenance can retry UNMATCHED once its local record becomes available', async () => {
			const base = await stored((await create()).id);
			const id = randomUUID();
			const external = 'cs_test_' + randomUUID().replace(/-/g, '');
			const template = stub.payments.get(base.providerPaymentId!)!;
			stub.add({
				...template,
				id: external,
				status: 'complete',
				payment_status: 'paid',
				client_reference_id: id,
				metadata: { paymentId: id, workspaceId: ids.workspace },
			});
			await webhook(external).expect(200);
			await insertLocal(base, id);
			await prisma.paymentEvent.update({
				where: eventKey(external),
				data: { nextReconcileAt: new Date(0) },
			});
			await maintenance().runOnce();
			expect(await stored(id)).toMatchObject({ status: 'SUCCEEDED', providerPaymentId: external });
		});

		it('recovers an unknown provider ID with exactly the original key and serialized body', async () => {
			stub.loseNextCreateResponse();
			const response = await post().expect(202);
			const local = response.body as PublicPayment;
			const before = await stored(local.id);
			expect(before.providerPaymentId).toBeNull();
			expect(before.status).toBe('CREATED');
			const initial = stub.creates.at(-1)!;
			await reconcile(local.id).expect(200);
			const after = await stored(local.id);
			expect(after.providerPaymentId).not.toBeNull();
			expect(after.firstDispatchedAt).toEqual(before.firstDispatchedAt);
			expect(stub.creates.at(-1)).toEqual(initial);
			expect(
				[...stub.payments.values()].filter((payment) => payment.metadata.paymentId === local.id),
			).toHaveLength(1);
		});

		it('recovers the same external operation when local persistence fails after a successful create response', async () => {
			const transaction = jest
				.spyOn(prisma, '$transaction')
				.mockRejectedValueOnce(new Error('Injected persistence outage'));
			let localId: string;
			let originalRequest: (typeof stub.creates)[number];
			try {
				await post().expect(500);
				originalRequest = stub.creates.at(-1)!;
				localId = (originalRequest.body.metadata as { paymentId: string }).paymentId;
				expect(await stored(localId)).toMatchObject({ status: 'CREATED', providerPaymentId: null });
			} finally {
				transaction.mockRestore();
			}
			await reconcile(localId!).expect(200);
			expect(stub.creates.at(-1)).toEqual(originalRequest!);
			expect((await stored(localId!)).providerPaymentId).not.toBeNull();
			expect(
				[...stub.payments.values()].filter((payment) => payment.metadata.paymentId === localId!),
			).toHaveLength(1);
		});

		it('does not retry unknown create after 23h from either manual or maintenance; a late webhook can recover', async () => {
			stub.loseNextCreateResponse();
			const created = await post().expect(202);
			const local = created.body as PublicPayment;
			const external = [...stub.payments.values()].find(
				(payment) => payment.metadata.paymentId === local.id,
			)!;
			await prisma.payment.update({
				where: { id: local.id },
				data: { firstDispatchedAt: new Date(Date.now() - 23 * 60 * 60 * 1000 - 1000) },
			});
			await makeDue(local.id);
			const createCount = stub.creates.length;
			await reconcile(local.id).expect(200);
			await makeDue(local.id);
			await maintenance().runOnce();
			expect(stub.creates).toHaveLength(createCount);
			expect(await stored(local.id)).toMatchObject({
				status: 'CREATED',
				needsReview: true,
				providerPaymentId: null,
			});
			stub.change(external.id, { status: 'complete', payment_status: 'paid' });
			await webhook(external.id).expect(200);
			expect(await stored(local.id)).toMatchObject({
				status: 'SUCCEEDED',
				needsReview: false,
				providerPaymentId: external.id,
			});
		});

		it('uses GET for a known provider ID even beyond the create retry window', async () => {
			const local = await create();
			const external = await providerId(local.id);
			await prisma.payment.update({
				where: { id: local.id },
				data: { firstDispatchedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
			});
			stub.change(external, { status: 'complete', payment_status: 'paid' });
			const creates = stub.creates.length;
			await reconcile(local.id).expect(200);
			expect(stub.creates).toHaveLength(creates);
			expect(stub.gets).toContain(external);
			expect((await stored(local.id)).status).toBe('SUCCEEDED');
		});

		it('retains uncertainty after a provider 5xx rather than declaring FAILED', async () => {
			stub.failNextCreate(500);
			const response = await post().expect(202);
			expect(await stored((response.body as PublicPayment).id)).toMatchObject({
				status: 'CREATED',
				providerPaymentId: null,
			});
		});

		it('does not declare FAILED on a later 401 after the first POST was already accepted', async () => {
			stub.loseNextCreateResponse();
			const response = await post().expect(202);
			const local = response.body as PublicPayment;
			const external = [...stub.payments.values()].find(
				(payment) => payment.metadata.paymentId === local.id,
			)!;
			stub.failNextCreate(401);
			await reconcile(local.id).expect(200);
			expect(await stored(local.id)).toMatchObject({ status: 'CREATED', providerPaymentId: null });
			expect(stub.payments.has(external.id)).toBe(true);
		});

		it('marks an inconsistent expired-but-paid session for review instead of inventing a terminal state', async () => {
			const local = await create();
			const external = await providerId(local.id);
			stub.change(external, { status: 'expired', payment_status: 'paid' });
			await reconcile(local.id).expect(200);
			expect(await stored(local.id)).toMatchObject({ status: 'PENDING', needsReview: true });
		});

		it('restricts commands, history and payment IDs through current workspace membership', async () => {
			const local = await create();
			for (const user of [ids.member, ids.viewer]) {
				await post(randomUUID(), user).expect(403);
				await request(app.getHttpServer())
					.get(`/workspaces/${ids.workspace}/payments`)
					.set(auth(user))
					.expect(403);
				await request(app.getHttpServer()).get(`/payments/${local.id}`).set(auth(user)).expect(403);
				await request(app.getHttpServer())
					.get(`/payments/${local.id}/events`)
					.set(auth(user))
					.expect(403);
				await reconcile(local.id, user).expect(403);
			}
			await post(randomUUID(), ids.outsider).expect(404);
			await request(app.getHttpServer())
				.get(`/payments/${local.id}`)
				.set(auth(ids.outsider))
				.expect(404);
			await reconcile(local.id, ids.outsider).expect(404);
			await request(app.getHttpServer())
				.get(`/payments/${local.id}/events`)
				.set(auth(ids.outsider))
				.expect(404);
			await request(app.getHttpServer()).get(`/payments/${local.id}/events`).expect(401);
			await request(app.getHttpServer()).get(`/payments/${local.id}`).expect(401);
			const history = await request(app.getHttpServer())
				.get(`/workspaces/${ids.workspace}/payments?limit=2`)
				.set(auth())
				.expect(200);
			expect(history.body).toHaveLength(2);
			await request(app.getHttpServer())
				.get(`/workspaces/${ids.workspace}/payments?limit=101`)
				.set(auth())
				.expect(400);
		});

		it('streams committed changes from another SQL client and reconnects with the current snapshot', async () => {
			const local = await create();
			const writer = new PrismaClient({ datasources: { db: { url: dedicatedDatabaseUrl() } } });
			let releaseInitial: () => void = () => {};
			const initial = new Promise<void>((resolve) => (releaseInitial = resolve));
			const stream = request(app.getHttpServer())
				.get(`/payments/${local.id}/events`)
				.set(auth())
				.buffer(true)
				.parse((response, done) => {
					let text = '';
					response.setEncoding('utf8');
					response.on('data', (chunk: string) => {
						text += chunk;
						if (text.includes('"status":"PENDING"')) releaseInitial();
					});
					response.on('end', () => done(null, text));
					response.on('error', done);
				});
			const result = stream.then((response) => response);
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					initial,
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(() => reject(new Error('Initial SSE snapshot missing')), 5_000);
					}),
				]);
				await writer.payment.update({
					where: { id: local.id },
					data: { status: 'SUCCEEDED', confirmationUrl: null },
				});
				const response = await result;
				expect(response.status).toBe(200);
				expect(response.headers['content-type']).toContain('text/event-stream');
				const parseEvents = (text: string): PublicPayment[] =>
					text
						.split('\n\n')
						.filter((frame) => frame.includes('event: payment\n'))
						.map(
							(frame) =>
								JSON.parse(
									frame
										.split('\n')
										.find((line) => line.startsWith('data: '))!
										.slice(6),
								) as PublicPayment,
						);
				const events = parseEvents(response.body as string);
				expect(events.map((event) => event.status)).toEqual(['PENDING', 'SUCCEEDED']);
				const current = await request(app.getHttpServer())
					.get(`/payments/${local.id}`)
					.set(auth())
					.expect(200);
				expect(events[1]).toEqual(current.body);
				const reconnected = await request(app.getHttpServer())
					.get(`/payments/${local.id}/events`)
					.set(auth())
					.buffer(true)
					.parse((response, done) => {
						let text = '';
						response.setEncoding('utf8');
						response.on('data', (chunk: string) => (text += chunk));
						response.on('end', () => done(null, text));
						response.on('error', done);
					})
					.expect(200);
				expect(parseEvents(reconnected.body as string)).toEqual([current.body]);
			} finally {
				clearTimeout(timeout);
				stream.abort();
				await result.catch(() => {});
				await writer.$disconnect();
			}
		});

		it('stops SQL observation when the HTTP SSE client disconnects', async () => {
			const local = await create();
			const get = jest.spyOn(app.get(PaymentsService), 'get');
			let releaseInitial: () => void = () => {};
			const initial = new Promise<void>((resolve) => (releaseInitial = resolve));
			const stream = request(app.getHttpServer())
				.get(`/payments/${local.id}/events`)
				.set(auth())
				.buffer(true)
				.parse((response, done) => {
					let text = '';
					response.setEncoding('utf8');
					response.on('data', (chunk: string) => {
						text += chunk;
						if (text.includes('event: payment\n')) releaseInitial();
					});
					response.on('end', () => done(null, text));
				});
			const result = stream.then(
				() => {},
				() => {},
			);
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					initial,
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(() => reject(new Error('Initial SSE snapshot missing')), 5_000);
					}),
				]);
				stream.abort();
				await result;
				await new Promise((resolve) => setTimeout(resolve, PAYMENT_EVENTS_INTERVAL_MS + 100));
				expect(get.mock.calls.filter(([, id]) => id === local.id)).toHaveLength(1);
			} finally {
				clearTimeout(timeout);
				stream.abort();
				await result;
				get.mockRestore();
			}
		});

		it('preserves payment history on workspace deletion and keeps ordinary workspace CRUD working', async () => {
			const workspace = await request(app.getHttpServer())
				.post('/workspaces')
				.set(auth())
				.send({ name: 'Payment retention fixture' })
				.expect(201);
			const workspaceId = (workspace.body as { id: string }).id;
			workspaces.push(workspaceId);
			const payment = await create(randomUUID(), ids.owner, workspaceId);
			await request(app.getHttpServer())
				.patch(`/workspaces/${workspaceId}`)
				.set(auth())
				.send({ name: 'Renamed retention fixture' })
				.expect(200);
			await request(app.getHttpServer())
				.patch(`/workspaces/${workspaceId}/archive`)
				.set(auth())
				.expect(200)
				.expect((response) => expect(response.body.status).toBe('ARCHIVED'));
			const blocked = await request(app.getHttpServer())
				.delete(`/workspaces/${workspaceId}`)
				.set(auth())
				.expect(409);
			expect(blocked.body).toMatchObject({ code: 'WORKSPACE_HAS_PAYMENTS' });
			expect((await stored(payment.id)).workspaceId).toBe(workspaceId);
			const empty = await request(app.getHttpServer())
				.post('/workspaces')
				.set(auth())
				.send({ name: 'Ordinary empty workspace' })
				.expect(201);
			const emptyId = (empty.body as { id: string }).id;
			workspaces.push(emptyId);
			await request(app.getHttpServer()).delete(`/workspaces/${emptyId}`).set(auth()).expect(200);
			expect(await prisma.workspace.findUnique({ where: { id: emptyId } })).toBeNull();
		});

		it('validates key and purpose at HTTP boundary and ignores client price', async () => {
			const count = stub.creates.length;
			await post('not-a-uuid').expect(400);
			await request(app.getHttpServer())
				.post(`/workspaces/${ids.workspace}/payments`)
				.set(auth())
				.send({ purpose: 'WORKSPACE_DEMO' })
				.expect(400);
			await request(app.getHttpServer())
				.post(`/workspaces/${ids.workspace}/payments`)
				.set(auth())
				.set('Idempotency-Key', randomUUID())
				.send({ purpose: 'OTHER' })
				.expect(400);
			expect(stub.creates).toHaveLength(count);
			const response = await request(app.getHttpServer())
				.post(`/workspaces/${ids.workspace}/payments`)
				.set(auth())
				.set('Idempotency-Key', randomUUID())
				.send({ purpose: 'WORKSPACE_DEMO', amountMinor: 1 })
				.expect(201);
			expect(response.body).toMatchObject({ amountMinor: 1000, currency: 'USD' });
			expect(stub.creates.at(-1)!.body.line_items).toEqual([
				expect.objectContaining({
					quantity: 1,
					price_data: expect.objectContaining({ unit_amount: 1000, currency: 'usd' }),
				}),
			]);
		});

		it('two maintenance instances cannot concurrently own the same payment claim', async () => {
			stub.loseNextCreateResponse();
			const response = await post().expect(202);
			const local = response.body as PublicPayment;
			await makeDue(local.id);
			const firstWorker = maintenance();
			const secondWorker = maintenance();
			const held = stub.holdNextCreate();
			pendingRelease = held.release;
			const firstPass = firstWorker.runOnce();
			await held.ready;
			const requests = stub.creates.length;
			try {
				await secondWorker.runOnce();
				expect(stub.creates).toHaveLength(requests);
				expect((await stored(local.id)).leaseToken).not.toBeNull();
			} finally {
				held.release();
				await firstPass;
				await Promise.all([firstWorker.stop(), secondWorker.stop()]);
			}
			expect((await stored(local.id)).providerPaymentId).not.toBeNull();
			expect(
				await prisma.paymentAudit.count({ where: { paymentId: local.id, toStatus: 'PENDING' } }),
			).toBe(1);
		});

		it('a process that lost its lease cannot persist a late response; recovery uses the original external operation', async () => {
			const held = stub.holdNextCreate();
			pendingRelease = held.release;
			const creating = post().then((response) => response);
			const external = await held.ready;
			const localId = external.payment.metadata.paymentId;
			await prisma.payment.update({
				where: { id: localId },
				data: { leaseToken: randomUUID(), leaseUntil: new Date(0), version: { increment: 1 } },
			});
			held.release();
			const response = await creating;
			expect(response.status).toBe(202);
			expect(await stored(localId)).toMatchObject({ status: 'CREATED', providerPaymentId: null });
			await reconcile(localId).expect(200);
			expect(await stored(localId)).toMatchObject({
				status: 'PENDING',
				providerPaymentId: external.payment.id,
			});
			expect(stub.creates.at(-1)).toEqual(external.request);
			expect(await prisma.paymentAudit.count({ where: { paymentId: localId } })).toBe(1);
		});

		it('a stale event handler cannot apply a snapshot or overwrite the newer event lease after its GET returns', async () => {
			const local = await create();
			const external = await providerId(local.id);
			await webhook(external).expect(200);
			const event = await prisma.paymentEvent.findFirstOrThrow({
				where: { providerObjectId: external, eventType: 'checkout.session.completed' },
			});
			const oldLease = randomUUID();
			await prisma.paymentEvent.update({
				where: { id: event.id },
				data: { leaseToken: oldLease, leaseUntil: new Date(Date.now() + 60_000) },
			});
			stub.change(external, { status: 'complete', payment_status: 'paid' });
			const held = stub.holdNextGet();
			pendingRelease = held.release;
			const handling = expect(
				webhooks.recoverEvent({ ...event, leaseToken: oldLease }),
			).rejects.toMatchObject({ code: 'PAYMENT_EVENT_LEASE_LOST' });
			await held.ready;
			const currentEvent = await prisma.paymentEvent.update({
				where: { id: event.id },
				data: { leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 120_000) },
			});
			held.release();
			await handling;
			expect(await prisma.paymentEvent.findUnique({ where: { id: event.id } })).toEqual(
				currentEvent,
			);
			expect((await stored(local.id)).status).toBe('PENDING');
			expect(
				await prisma.paymentAudit.count({ where: { paymentId: local.id, toStatus: 'SUCCEEDED' } }),
			).toBe(0);
			await prisma.paymentEvent.update({
				where: { id: event.id },
				data: { leaseToken: null, leaseUntil: null },
			});
			await webhook(external).expect(200);
			expect((await stored(local.id)).status).toBe('SUCCEEDED');
		});

		it('maintenance recovers after ownership is revoked and waits for an in-flight pass during shutdown', async () => {
			stub.loseNextCreateResponse();
			const response = await post().expect(202);
			const local = response.body as PublicPayment;
			await makeDue(local.id);
			await prisma.workspaceMember.update({
				where: { userId_workspaceId: { userId: ids.owner, workspaceId: ids.workspace } },
				data: { role: 'MEMBER' },
			});
			const runner = maintenance();
			const held = stub.holdNextCreate();
			pendingRelease = held.release;
			const running = runner.runOnce();
			await held.ready;
			let closed = false;
			const stopping = runner.stop().then(() => {
				closed = true;
			});
			await new Promise((resolve) => setImmediate(resolve));
			expect(closed).toBe(false);
			held.release();
			await running;
			await stopping;
			expect((await stored(local.id)).providerPaymentId).not.toBeNull();
			await post().expect(403);
			await prisma.workspaceMember.update({
				where: { userId_workspaceId: { userId: ids.owner, workspaceId: ids.workspace } },
				data: { role: 'OWNER' },
			});
		});
	},
);
