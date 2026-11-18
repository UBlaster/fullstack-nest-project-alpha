import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as request from 'supertest';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { PrismaService } from '../src/prisma/prisma.service';
import { createAppValidationPipe } from '../src/validation.pipe';
import type {
	PaymentContractBinding,
	PaymentContractHarness,
} from './task8-payment-contract.types';
import { PaymentProviderMock } from './task8-payment-provider.mock';
import { isolatedConfig } from './test-config';

const testDatabases = new Set([
	'task8_contract_test',
	'task8_payments_test',
	'task8_stripe_test',
	'task8_yookassa_test',
]);

function databaseTarget() {
	const value = process.env.TASK8_CONTRACT_DATABASE_URL;
	if (!value)
		throw new Error('Set TASK8_CONTRACT_DATABASE_URL to a dedicated Task 8 test database');
	const target = new URL(value);
	const name = target.pathname.slice(1);
	if (
		!['postgres:', 'postgresql:'].includes(target.protocol) ||
		!['localhost', '127.0.0.1', 'postgres'].includes(target.hostname) ||
		!testDatabases.has(name) ||
		target.hash ||
		(target.searchParams.get('schema') ?? 'public') !== 'public' ||
		target.searchParams.getAll('schema').length > 1 ||
		[...target.searchParams.keys()].some((key) => !['schema', 'connection_limit'].includes(key))
	) {
		throw new Error('Use a dedicated local task8_*_test database in the public schema');
	}
	if (!target.searchParams.has('connection_limit'))
		target.searchParams.set('connection_limit', '5');
	return { name, url: target.href };
}

export async function createPaymentContractHarness(
	binding: PaymentContractBinding,
): Promise<PaymentContractHarness> {
	const target = databaseTarget();
	const prisma = new PrismaClient({ datasources: { db: { url: target.url } } });
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
	let app: INestApplication | undefined;
	let fixturesStarted = false;

	const close = async () => {
		try {
			await app?.close();
		} finally {
			try {
				if (fixturesStarted) {
					await prisma.$transaction([
						prisma.$executeRaw`DELETE FROM "PaymentEvent" WHERE "paymentId" IN (
							SELECT id FROM "Payment" WHERE "workspaceId" IN (${workspaceId}, ${otherWorkspaceId}))`,
						prisma.$executeRaw`DELETE FROM "PaymentAudit" WHERE "paymentId" IN (
							SELECT id FROM "Payment" WHERE "workspaceId" IN (${workspaceId}, ${otherWorkspaceId}))`,
						prisma.$executeRaw`DELETE FROM "Payment" WHERE "workspaceId" IN (${workspaceId}, ${otherWorkspaceId})`,
						prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaces } } }),
						prisma.workspace.deleteMany({ where: { id: { in: workspaces } } }),
						prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } }),
					]);
				}
			} finally {
				await prisma.$disconnect();
			}
		}
	};

	try {
		const [database] = await prisma.$queryRaw<Array<{ name: string; ready: boolean }>>`
			SELECT current_database() AS name,
				to_regclass('public."Payment"') IS NOT NULL AND
				to_regclass('public."PaymentEvent"') IS NOT NULL AND
				to_regclass('public."PaymentAudit"') IS NOT NULL AS ready
		`;
		if (database.name !== target.name) throw new Error('Unexpected physical test database');
		if (!database.ready) throw new Error('Apply Task 8 migrations to the dedicated test database');

		const jwtSecret = randomUUID();
		const jwt = new JwtService({
			secret: jwtSecret,
			signOptions: { algorithm: 'HS256', expiresIn: '5m' },
		});
		const config = isolatedConfig({ JWT_SECRET: jwtSecret });
		const mock = binding.mockProvider(provider);
		const module = await Test.createTestingModule({
			imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), binding.module],
			providers: [JwtStrategy],
		})
			.overrideProvider(ConfigService)
			.useValue(config)
			.overrideProvider(PrismaService)
			.useValue(prisma)
			.overrideProvider(binding.providerToken)
			.useValue(mock)
			.compile();
		app = module.createNestApplication({ logger: false });
		if (module.get(binding.providerToken) !== mock || module.get(PrismaService) !== prisma) {
			throw new Error('Payment contract requires the mocked provider and dedicated Prisma client');
		}
		app.useGlobalPipes(createAppValidationPipe());
		await app.init();

		fixturesStarted = true;
		await prisma.$transaction([
			prisma.user.createMany({
				data: Object.values(users).map((id) => ({
					id,
					email: `${id}@example.test`,
					name: 'Contract fixture',
					password: 'unused-test-fixture',
				})),
			}),
			prisma.workspace.createMany({
				data: workspaces.map((id) => ({ id, name: 'Contract fixture' })),
			}),
			prisma.workspaceMember.createMany({
				data: [
					{ userId: users.owner, workspaceId, role: 'OWNER' },
					{ userId: users.owner, workspaceId: otherWorkspaceId, role: 'OWNER' },
					{ userId: users.member, workspaceId, role: 'MEMBER' },
					{ userId: users.viewer, workspaceId, role: 'VIEWER' },
					{ userId: users.outsider, workspaceId: otherWorkspaceId, role: 'OWNER' },
				],
			}),
		]);
		const server = app.getHttpServer();
		return {
			workspaceId,
			otherWorkspaceId,
			provider,
			close,
			async request(method, path, { user = 'owner', key, body } = {}) {
				const call = method === 'GET' ? request(server).get(path) : request(server).post(path);
				if (user !== 'anonymous') {
					const id = users[user];
					call.auth(jwt.sign({ sub: id, email: `${id}@example.test` }), { type: 'bearer' });
				}
				if (key !== undefined) call.set('Idempotency-Key', key);
				if (body !== undefined) call.send(body as object);
				const response = await call.timeout({ deadline: 8_000 });
				return { status: response.status, body: response.body as unknown };
			},
			notify(paymentId, event) {
				return binding.notify(module, provider.forPayment(paymentId).id, event);
			},
			async records(paymentId) {
				const [counts] = await prisma.$queryRaw<Array<{ events: number; changes: number }>>`
					SELECT
						(SELECT count(*)::int FROM "PaymentEvent" WHERE "paymentId"::text = ${paymentId}) AS events,
						(SELECT count(*)::int FROM "PaymentAudit" WHERE "paymentId"::text = ${paymentId}) AS changes
				`;
				return counts;
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}
