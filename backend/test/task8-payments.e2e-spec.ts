import { randomUUID } from 'node:crypto';
import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient, WorkspaceRole } from '@prisma/client';
import * as request from 'supertest';
import { AuthenticatedRequest } from '../src/auth/authenticated-request';
import { PaymentMaintenanceService } from '../src/payments/payment-maintenance.service';
import { PaymentsModule } from '../src/payments/payments.module';
import { PaymentsService } from '../src/payments/payments.service';
import { YOOKASSA_API_BASE } from '../src/payments/yookassa-payment.provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { createAppValidationPipe } from '../src/validation.pipe';
import { WorkspacesModule } from '../src/workspaces/workspaces.module';
import { isolatedConfig } from './test-config';
import { StubPayment, YooKassaStub } from './task8-yookassa-stub';

const describePayments = process.env.TASK8_PAYMENTS_E2E === 'true' ? describe : describe.skip;

function dedicatedDatabaseUrl(): string {
	const value = process.env.TASK8_PAYMENTS_DATABASE_URL;
	if (!value) throw new Error('TASK8_PAYMENTS_DATABASE_URL is required for Task 8 SQL tests');
	let target: URL;
	try {
		target = new URL(value);
	} catch {
		throw new Error('Invalid Task 8 test database configuration');
	}
	if (
		!['postgres:', 'postgresql:'].includes(target.protocol) ||
		!['localhost', '127.0.0.1'].includes(target.hostname) ||
		target.port !== '55437' ||
		target.pathname !== '/task8_payments_test' ||
		(target.searchParams.get('schema') ?? 'public') !== 'public' ||
		target.searchParams.getAll('schema').length > 1 ||
		[...target.searchParams.keys()].some((key) => key !== 'schema')
	) {
		throw new Error('Only the dedicated local task8_payments_test database is allowed');
	}
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
			YOOKASSA_SHOP_ID: '123456789',
			YOOKASSA_SECRET_KEY: 'test_task8_key',
			PAYMENT_RETURN_BASE_URL: 'http://localhost:5173',
			PAYMENT_HTTP_TIMEOUT_MS: 2000,
			PAYMENT_RECONCILE_INTERVAL_MS: 60_000,
		});
		const stub = new YooKassaStub();
		let prisma: PrismaClient;
		let app: INestApplication;
		let service: PaymentsService;
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
		const webhook = (id: string, event = 'payment.succeeded') =>
			request(app.getHttpServer())
				.post('/payments/webhooks/yookassa')
				.send({ type: 'notification', event, object: { id, status: 'succeeded' } });
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
			if (target.database !== 'task8_payments_test') throw new Error('Unexpected physical test DB');
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
				.overrideProvider(YOOKASSA_API_BASE)
				.useValue(stub.baseUrl)
				.overrideGuard(AuthGuard('jwt'))
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
			app = module.createNestApplication({ logger: false });
			app.useGlobalPipes(createAppValidationPipe());
			await app.init();
			service = module.get(PaymentsService);
		});
		const maintenance = () =>
			new PaymentMaintenanceService(service, prisma as PrismaService, config);
		const insertLocal = async (base: Awaited<ReturnType<typeof stored>>, id: string) => {
			const body = base.providerRequest as Prisma.InputJsonObject;
			return prisma.payment.create({
				data: {
					id,
					workspaceId: ids.workspace,
					userId: ids.owner,
					purpose: 'WORKSPACE_DEMO',
					amountMinor: 10_000,
					currency: 'RUB',
					idempotencyKey: randomUUID(),
					requestHash: base.requestHash,
					providerIdempotenceKey: randomUUID(),
					providerRequest: { ...body, metadata: { paymentId: id, workspaceId: ids.workspace } },
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
				amountMinor: 10_000,
				currency: 'RUB',
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
			stub.change(payment.id, { status: 'succeeded', paid: true });
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
			await webhook(payment.id, 'payment.canceled').expect(200);
			expect(
				await prisma.paymentAudit.count({
					where: { paymentId: payment.metadata.paymentId, toStatus: 'SUCCEEDED' },
				}),
			).toBe(1);
		});

		it('rechecks the same event after a nonterminal snapshot instead of poisoning deduplication', async () => {
			const local = await create();
			const external = await providerId(local.id);
			await webhook(external).expect(200);
			expect(await stored(local.id)).toMatchObject({ status: 'PENDING' });
			stub.change(external, { status: 'succeeded', paid: true });
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
			stub.change(external, { status: 'canceled' });
			await webhook(external).expect(200);
			await webhook(external, 'payment.canceled').expect(200);
			expect((await stored(local.id)).status).toBe('CANCELLED');
			expect(
				await prisma.paymentAudit.count({ where: { paymentId: local.id, toStatus: 'CANCELLED' } }),
			).toBe(1);
			stub.change(external, { status: 'succeeded', paid: true });
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
				status: 'succeeded',
				paid: true,
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
			stub.change(external, { status: 'succeeded', paid: true });
			// Exclude ordinary Payment recovery so this proves durable event recovery specifically.
			await prisma.payment.update({
				where: { id: local.id },
				data: { nextReconcileAt: new Date(Date.now() + 86_400_000) },
			});
			await prisma.paymentEvent.updateMany({
				where: { providerObjectId: external },
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
			['live mode', (snapshot: StubPayment) => ({ ...snapshot, test: false })],
			[
				'foreign shop',
				(snapshot: StubPayment) => ({
					...snapshot,
					recipient: { ...snapshot.recipient, account_id: 'foreign-shop' },
				}),
			],
			[
				'amount',
				(snapshot: StubPayment) => ({
					...snapshot,
					amount: { ...snapshot.amount, value: '99.99' },
				}),
			],
			[
				'currency',
				(snapshot: StubPayment) => ({
					...snapshot,
					amount: { ...snapshot.amount, currency: 'USD' },
				}),
			],
			[
				'workspace metadata',
				(snapshot: StubPayment) => ({
					...snapshot,
					metadata: { ...snapshot.metadata, workspaceId: ids.otherWorkspace },
				}),
			],
		])('does not accept a terminal snapshot with invalid %s', async (_name, transform) => {
			const local = await create();
			const external = await providerId(local.id);
			stub.change(external, { status: 'succeeded', paid: true });
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
			stub.change(external, { status: 'succeeded', paid: true });
			stub.failNextGet();
			await webhook(external).expect(503);
			expect((await stored(local.id)).status).toBe('PENDING');
			await webhook(external).expect(200);
			expect((await stored(local.id)).status).toBe('SUCCEEDED');
		});

		it('durably records UNMATCHED and can apply its later delivery after the local record becomes available', async () => {
			const base = await stored((await create()).id);
			const id = randomUUID();
			const external = randomUUID();
			const template = stub.payments.get(base.providerPaymentId!)!;
			stub.add({
				...template,
				id: external,
				status: 'succeeded',
				paid: true,
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
			const external = randomUUID();
			const template = stub.payments.get(base.providerPaymentId!)!;
			stub.add({
				...template,
				id: external,
				status: 'succeeded',
				paid: true,
				metadata: { paymentId: id, workspaceId: ids.workspace },
			});
			await webhook(external).expect(200);
			await insertLocal(base, id);
			await prisma.paymentEvent.updateMany({
				where: { providerObjectId: external },
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
			stub.change(external.id, { status: 'succeeded', paid: true });
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
			stub.change(external, { status: 'succeeded', paid: true });
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

		it('treats waiting_for_capture as manual review and never confirms or captures automatically', async () => {
			const local = await create();
			const external = await providerId(local.id);
			stub.change(external, { status: 'waiting_for_capture' });
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
				await reconcile(local.id, user).expect(403);
			}
			await post(randomUUID(), ids.outsider).expect(404);
			await request(app.getHttpServer())
				.get(`/payments/${local.id}`)
				.set(auth(ids.outsider))
				.expect(404);
			await reconcile(local.id, ids.outsider).expect(404);
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
			expect(response.body).toMatchObject({ amountMinor: 10_000, currency: 'RUB' });
			expect(stub.creates.at(-1)!.body.amount).toEqual({ value: '100.00', currency: 'RUB' });
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
				where: { providerObjectId: external, eventType: 'payment.succeeded' },
			});
			const oldLease = randomUUID();
			await prisma.paymentEvent.update({
				where: { id: event.id },
				data: { leaseToken: oldLease, leaseUntil: new Date(Date.now() + 60_000) },
			});
			stub.change(external, { status: 'succeeded', paid: true });
			const held = stub.holdNextGet();
			pendingRelease = held.release;
			const handling = expect(
				service.webhook('payment.succeeded', external, oldLease),
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
			const maintenance = new PaymentMaintenanceService(service, prisma as PrismaService, config);
			const held = stub.holdNextCreate();
			pendingRelease = held.release;
			const running = maintenance.runOnce();
			await held.ready;
			let closed = false;
			const stopping = maintenance.stop().then(() => {
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
