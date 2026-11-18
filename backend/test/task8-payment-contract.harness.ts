import { randomUUID } from 'node:crypto';
import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as request from 'supertest';
import { AuthenticatedRequest } from '../src/auth/authenticated-request';
import { JwtAuthGuard } from '../src/auth/decorators/jwt-auth.decorator';
import { PaymentProviderError, WORKSPACE_PAYMENT_PRICE } from '../src/payments/payment-provider';
import { PaymentWebhookService } from '../src/payments/payment-webhook.service';
import { PaymentsModule } from '../src/payments/payments.module';
import { StripePaymentProvider } from '../src/payments/stripe-payment.provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { createAppValidationPipe } from '../src/validation.pipe';
import type { ContractPayment, PaymentContractHarness } from './task8-payment-contract.types';
import {
	MockPaymentRequest,
	MockPaymentSnapshot,
	PaymentProviderMock,
} from './task8-payment-provider.mock';
import { isolatedConfig } from './test-config';

function dedicatedDatabaseUrl(): string {
	const value = process.env.TASK8_PAYMENTS_DATABASE_URL;
	if (!value) throw new Error('TASK8_PAYMENTS_DATABASE_URL is required');
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

export async function createPaymentContractHarness(): Promise<PaymentContractHarness> {
	const prisma = new PrismaClient({ datasources: { db: { url: dedicatedDatabaseUrl() } } });
	const run = `contract-${randomUUID()}`;
	const users = {
		owner: `${run}-owner`,
		member: `${run}-member`,
		viewer: `${run}-viewer`,
		outsider: `${run}-outsider`,
	};
	const workspaceId = `${run}-workspace`;
	const otherWorkspaceId = `${run}-other`;
	const workspaces = [workspaceId, otherWorkspaceId];
	const provider = new PaymentProviderMock();
	const providerId = (id: string) => `cs_test_${id.replace(/-/g, '')}`;
	const snapshot = (row: MockPaymentSnapshot) => ({
		provider: WORKSPACE_PAYMENT_PRICE.provider,
		id: providerId(row.id),
		status: row.status,
		test: row.test,
		amountMinor: row.amountMinor,
		currency: row.currency,
		metadata: { paymentId: row.paymentId, workspaceId: row.workspaceId },
		clientReferenceId: row.paymentId,
		confirmationUrl: row.confirmationUrl,
	});
	const providerPort = {
		isConfigured: () => true,
		assertConfigured: () => {},
		validateContext: () => {},
		httpTimeoutMs: () => 1_000,
		requestFor: (paymentId: string, workspaceId: string): MockPaymentRequest => ({
			paymentId,
			workspaceId,
			amountMinor: WORKSPACE_PAYMENT_PRICE.amountMinor,
			currency: WORKSPACE_PAYMENT_PRICE.currency,
		}),
		create: async (body: MockPaymentRequest, key: string) => {
			try {
				return snapshot(await provider.create(body, key));
			} catch {
				throw new PaymentProviderError('PROVIDER_UNAVAILABLE');
			}
		},
		get: async (id: string) => {
			const row = provider.creates
				.map((call) => provider.forPayment(call.request.paymentId))
				.find((row) => providerId(row.id) === id);
			if (!row) throw new PaymentProviderError('PROVIDER_HTTP_404');
			return snapshot(provider.get(row.id));
		},
	};
	let app: INestApplication | undefined;
	let verified = false;
	const close = async () => {
		await app?.close();
		if (verified) {
			await prisma.paymentEvent.deleteMany({
				where: { payment: { workspaceId: { in: workspaces } } },
			});
			await prisma.paymentAudit.deleteMany({
				where: { payment: { workspaceId: { in: workspaces } } },
			});
			await prisma.payment.deleteMany({ where: { workspaceId: { in: workspaces } } });
			await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaces } } });
			await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
			await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
		}
		await prisma.$disconnect();
	};
	try {
		await prisma.$connect();
		const [target] = await prisma.$queryRaw<
			Array<{ database: string }>
		>`SELECT current_database() AS database`;
		if (target.database !== 'task8_stripe_test')
			throw new Error('Unexpected physical test database');
		verified = true;
		await prisma.user.createMany({
			data: Object.values(users).map((id) => ({
				id,
				email: `${id}@example.test`,
				name: 'Contract fixture',
				password: 'unused-test-fixture',
			})),
		});
		await prisma.workspace.createMany({
			data: workspaces.map((id) => ({ id, name: 'Contract fixture' })),
		});
		await prisma.workspaceMember.createMany({
			data: [
				{ userId: users.owner, workspaceId, role: 'OWNER' },
				{ userId: users.owner, workspaceId: otherWorkspaceId, role: 'OWNER' },
				{ userId: users.member, workspaceId, role: 'MEMBER' },
				{ userId: users.viewer, workspaceId, role: 'VIEWER' },
			],
		});
		const module = await Test.createTestingModule({
			imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PaymentsModule],
		})
			.overrideProvider(ConfigService)
			.useValue(isolatedConfig())
			.overrideProvider(PrismaService)
			.useValue(prisma)
			.overrideProvider(StripePaymentProvider)
			.useValue(providerPort)
			.overrideGuard(JwtAuthGuard)
			.useValue({
				canActivate(context: ExecutionContext) {
					const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
					const id = req.headers['x-contract-user'];
					if (typeof id !== 'string' || !Object.values(users).includes(id))
						throw new UnauthorizedException();
					req.user = { sub: id, email: `${id}@example.test` };
					return true;
				},
			})
			.compile();
		app = module.createNestApplication({ logger: false });
		app.useGlobalPipes(createAppValidationPipe());
		await app.listen(0, '127.0.0.1');
		const server = app.getHttpServer();
		const baseUrl = await app.getUrl();
		const webhooks = module.get(PaymentWebhookService);
		return {
			workspaceId,
			otherWorkspaceId,
			provider,
			close,
			async request(method, path, options = {}) {
				const call = method === 'GET' ? request(server).get(path) : request(server).post(path);
				const user = options.user ?? 'owner';
				if (user !== 'anonymous') call.set('x-contract-user', users[user]);
				if (options.key !== undefined) call.set('Idempotency-Key', options.key);
				if (options.body !== undefined) call.send(options.body as object);
				const response = await call;
				return { status: response.status, body: response.body as unknown };
			},
			async notify(id) {
				await webhooks.recoverEvent({
					eventType: 'checkout.session.completed',
					providerObjectId: providerId(provider.forPayment(id).id),
				});
			},
			auditCount: (paymentId) => prisma.paymentAudit.count({ where: { paymentId } }),
			async events(id) {
				const controller = new AbortController();
				const deadline = setTimeout(() => controller.abort(), 5_000);
				const response = await fetch(`${baseUrl}/payments/${id}/events`, {
					signal: controller.signal,
					headers: { 'x-contract-user': users.owner },
				});
				if (!response.ok || !response.body) {
					clearTimeout(deadline);
					controller.abort();
					throw new Error(`SSE returned HTTP ${response.status}`);
				}
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';
				return {
					async next() {
						while (true) {
							const end = buffer.indexOf('\n\n');
							if (end !== -1) {
								const frame = buffer.slice(0, end);
								buffer = buffer.slice(end + 2);
								if (!frame.includes('event: payment\n')) continue;
								const data = frame.split('\n').find((line) => line.startsWith('data: '));
								if (data) return JSON.parse(data.slice(6)) as ContractPayment;
							} else {
								const chunk = await reader.read();
								if (chunk.done) throw new Error('SSE ended before the expected payment snapshot');
								buffer += decoder.decode(chunk.value, { stream: true });
							}
						}
					},
					async close() {
						clearTimeout(deadline);
						controller.abort();
						await reader.cancel().catch(() => {});
					},
				};
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}
