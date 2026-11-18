import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Payment, PaymentStatus, Prisma } from '@prisma/client';
import { AccessPolicyService } from '../src/access/access-policy.service';
import { PaymentRecoveryService } from '../src/payments/payment-recovery.service';
import { PaymentTransitionService } from '../src/payments/payment-transition.service';
import { PaymentsService } from '../src/payments/payments.service';
import { PaymentProviderSnapshot } from '../src/payments/payment-provider';
import { StripePaymentProvider } from '../src/payments/stripe-payment.provider';
import { PrismaService } from '../src/prisma/prisma.service';

const userId = 'response-test-owner';
const workspaceId = 'response-test-workspace';
const paymentId = 'a812c5d1-20cc-4f81-829c-aad4bcb6c8e3';
const clientKey = '604f72aa-8258-4810-a303-b3d3d756dfdf';
const now = new Date('2026-11-16T10:00:00Z');
const confirmationUrl = 'https://checkout.stripe.com/c/pay/test_response';
const responseFields = [
	'id',
	'workspaceId',
	'purpose',
	'provider',
	'amountMinor',
	'currency',
	'status',
	'confirmationUrl',
	'needsReview',
	'lastErrorCode',
	'createdAt',
	'updatedAt',
];
const privateFields: readonly (keyof Payment)[] = [
	'userId',
	'idempotencyKey',
	'requestHash',
	'providerIdempotenceKey',
	'providerRequest',
	'providerPaymentId',
	'firstDispatchedAt',
	'createAttempts',
	'version',
	'nextReconcileAt',
	'reconcileAttempts',
	'leaseToken',
	'leaseUntil',
];

function fixture(overrides: Partial<Payment> = {}): Payment {
	return {
		id: paymentId,
		workspaceId,
		userId,
		purpose: 'WORKSPACE_DEMO',
		provider: 'stripe',
		amountMinor: 1_000,
		currency: 'USD',
		status: 'PENDING',
		providerPaymentId: 'cs_test_private_id',
		confirmationUrl,
		idempotencyKey: clientKey,
		requestHash: 'private-request-fingerprint',
		providerIdempotenceKey: 'c6c396fb-afbe-4934-8b79-1a6306ec175d',
		providerRequest: { marker: 'private-saved-provider-body' },
		firstDispatchedAt: now,
		createAttempts: 1,
		version: 4,
		needsReview: false,
		lastErrorCode: null,
		nextReconcileAt: now,
		reconcileAttempts: 3,
		leaseToken: '893b998c-c728-4c48-8a29-3d54f6c559dd',
		leaseUntil: now,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function project(row: Payment, select: Prisma.PaymentSelect | null | undefined): Partial<Payment> {
	if (!select) throw new Error('An explicit Payment select is required');
	const selected: Partial<Payment> = {};
	const copy = <K extends keyof Payment>(field: K): void => {
		if (select[field] === true) selected[field] = row[field];
	};
	(Object.keys(row) as Array<keyof Payment>).forEach(copy);
	return selected;
}

interface FindArgs {
	where: Prisma.PaymentWhereUniqueInput;
	select?: Prisma.PaymentSelect;
}

interface CreateArgs {
	data: Pick<Payment, 'id' | 'workspaceId' | 'userId' | 'idempotencyKey' | 'requestHash'>;
	select?: Prisma.PaymentSelect;
}

function publicSelection(select: Prisma.PaymentSelect | null | undefined): void {
	expect(select).toBeDefined();
	for (const field of privateFields) expect(select?.[field]).not.toBe(true);
	for (const field of responseFields) expect(select?.[field as keyof Payment]).toBe(true);
}

function publicContract(
	value: unknown,
	expected: {
		id: string;
		status: PaymentStatus;
		provider?: string;
		amountMinor?: number;
		currency?: string;
	},
): void {
	const wire: unknown = JSON.parse(JSON.stringify(value));
	expect(wire).toMatchObject({
		id: expected.id,
		workspaceId,
		purpose: 'WORKSPACE_DEMO',
		provider: expected.provider ?? 'stripe',
		amountMinor: expected.amountMinor ?? 1_000,
		currency: expected.currency ?? 'USD',
		status: expected.status,
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	});
	expect(typeof wire).toBe('object');
	if (typeof wire !== 'object' || wire === null)
		throw new Error('Expected a public payment object');
	expect(Object.keys(wire).sort()).toEqual([...responseFields].sort());
	for (const field of privateFields) expect(wire).not.toHaveProperty(field);
	expect(JSON.stringify(wire)).not.toContain('private-saved-provider-body');
}

describe('Task 8 payment query selection and public responses (no DB/network)', () => {
	let module: TestingModule;
	let service: PaymentsService;
	let recovery: PaymentRecoveryService;
	const rows = new Map<string, Payment>();
	const access = { requireWorkspace: jest.fn().mockResolvedValue({ id: workspaceId }) };
	const provider = {
		isConfigured: jest.fn().mockReturnValue(true),
		assertConfigured: jest.fn(),
		requestFor: jest.fn().mockReturnValue({ marker: 'private-saved-provider-body' }),
		create: jest.fn(),
		get: jest.fn(),
	};
	const find = ({ where, select }: FindArgs) => {
		const identity = where.userId_idempotencyKey;
		const row = identity
			? [...rows.values()].find(
					(candidate) =>
						candidate.userId === identity.userId &&
						candidate.idempotencyKey === identity.idempotencyKey,
				)
			: rows.get(where.id ?? '');
		return row ? project(row, select) : null;
	};
	const payment = {
		findUnique: jest.fn(async (args: FindArgs) => find(args)),
		findUniqueOrThrow: jest.fn(async (args: FindArgs) => {
			const row = find(args);
			if (!row) throw new NotFoundException();
			return row;
		}),
		findMany: jest.fn(async (args: Prisma.PaymentFindManyArgs) =>
			[...rows.values()]
				.filter((row) => row.workspaceId === args.where?.workspaceId)
				.map((row) => project(row, args.select)),
		),
		create: jest.fn(async (args: CreateArgs) => {
			const row = fixture({
				...args.data,
				status: 'CREATED',
				providerPaymentId: null,
				firstDispatchedAt: null,
			});
			rows.set(row.id, row);
			return project(row, args.select);
		}),
	};

	beforeEach(async () => {
		jest.clearAllMocks();
		rows.clear();
		rows.set(paymentId, fixture());
		access.requireWorkspace.mockResolvedValue({ id: workspaceId });
		provider.isConfigured.mockReturnValue(true);
		module = await Test.createTestingModule({
			providers: [
				PaymentsService,
				PaymentRecoveryService,
				{ provide: PrismaService, useValue: { payment } },
				{ provide: AccessPolicyService, useValue: access },
				{ provide: StripePaymentProvider, useValue: provider },
				{ provide: PaymentTransitionService, useValue: {} },
			],
		}).compile();
		service = module.get(PaymentsService);
		recovery = module.get(PaymentRecoveryService);
	});
	afterEach(async () => {
		jest.restoreAllMocks();
		await module.close();
	});

	it.each([true, false])(
		'reports enabled=%s only after workspace authorization',
		async (enabled) => {
			provider.isConfigured.mockReturnValue(enabled);
			await expect(service.capabilities(userId, workspaceId)).resolves.toEqual({
				enabled,
				provider: 'stripe',
				amountMinor: 1_000,
				currency: 'USD',
			});
			expect(access.requireWorkspace).toHaveBeenCalledWith(userId, workspaceId, 'view', 'payment');
			expect(access.requireWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
				provider.isConfigured.mock.invocationCallOrder[0],
			);
			expect(payment.findUnique).not.toHaveBeenCalled();
			expect(payment.findMany).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ label: 'member', failure: new ForbiddenException() },
		{ label: 'outsider', failure: new NotFoundException() },
	])(
		'does not disclose payment availability when workspace access is rejected ($label)',
		async ({ failure }) => {
			access.requireWorkspace.mockRejectedValue(failure);
			await expect(service.capabilities(userId, workspaceId)).rejects.toBe(failure);
			expect(provider.isConfigured).not.toHaveBeenCalled();
			expect(payment.findUnique).not.toHaveBeenCalled();
			expect(payment.findMany).not.toHaveBeenCalled();
		},
	);

	it('reads a payment using public columns and returns the existing JSON contract', async () => {
		const result = await service.get(userId, paymentId);
		publicSelection(payment.findUnique.mock.calls[0][0].select);
		expect(access.requireWorkspace).toHaveBeenCalledWith(userId, workspaceId, 'view', 'payment');
		publicContract(result, { id: paymentId, status: 'PENDING' });
		expect(result.confirmationUrl).toBe(confirmationUrl);
	});

	it('selects only public columns for a workspace history and preserves its bounded query', async () => {
		const result = await service.history(userId, workspaceId, 5);
		const query = payment.findMany.mock.calls[0][0];
		publicSelection(query.select);
		expect(query).toMatchObject({
			where: { workspaceId },
			take: 5,
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
		});
		expect(result).toHaveLength(1);
		publicContract(result[0], { id: paymentId, status: 'PENDING' });
	});

	it.each<PaymentStatus>(['SUCCEEDED', 'CANCELLED', 'FAILED'])(
		'hides a persisted confirmation link for terminal %s',
		async (status) => {
			rows.set(paymentId, fixture({ status }));
			const result = await service.get(userId, paymentId);
			publicContract(result, { id: paymentId, status });
			expect(result.confirmationUrl).toBeNull();
		},
	);

	it('hides a confirmation link while the operation requires manual review', async () => {
		rows.set(paymentId, fixture({ needsReview: true }));
		const result = await service.get(userId, paymentId);
		publicContract(result, { id: paymentId, status: 'PENDING' });
		expect(result).toMatchObject({ confirmationUrl: null, needsReview: true });
	});

	it('keeps legacy YooKassa history readable while masking its old confirmation link', async () => {
		rows.set(
			paymentId,
			fixture({
				provider: 'yookassa',
				amountMinor: 10_000,
				currency: 'RUB',
				providerPaymentId: 'legacy-yookassa-id',
				confirmationUrl: 'https://yoomoney.ru/checkout/legacy',
			}),
		);
		const current = await service.get(userId, paymentId);
		const history = await service.history(userId, workspaceId, 20);
		for (const result of [current, ...history]) {
			publicContract(result, {
				id: paymentId,
				status: 'PENDING',
				provider: 'yookassa',
				amountMinor: 10_000,
				currency: 'RUB',
			});
			expect(result.confirmationUrl).toBeNull();
		}
		expect(provider.create).not.toHaveBeenCalled();
		expect(provider.get).not.toHaveBeenCalled();
		expect(rows.get(paymentId)).toMatchObject({ provider: 'yookassa', status: 'PENDING' });
	});

	it('rejects legacy reconciliation with 409 before configuration, recovery or Stripe calls', async () => {
		rows.set(paymentId, fixture({ provider: 'yookassa', amountMinor: 10_000, currency: 'RUB' }));
		const recover = jest.spyOn(recovery, 'recover');
		await expect(service.reconcile(userId, paymentId)).rejects.toBeInstanceOf(ConflictException);
		await expect(service.reconcile(userId, paymentId)).rejects.toMatchObject({
			status: 409,
			response: { code: 'PAYMENT_PROVIDER_UNSUPPORTED' },
		});
		expect(provider.assertConfigured).not.toHaveBeenCalled();
		expect(provider.create).not.toHaveBeenCalled();
		expect(provider.get).not.toHaveBeenCalled();
		expect(recover).not.toHaveBeenCalled();
	});

	it('returns 201 for a fresh known payment and 200 for the same key without exposing its internal identity', async () => {
		rows.clear();
		const recover = jest.spyOn(recovery, 'recover').mockImplementation(async (id) => {
			const row = rows.get(id);
			if (!row) throw new Error('Missing reserved payment');
			rows.set(id, {
				...row,
				status: 'PENDING',
				providerPaymentId: 'cs_test_private_created',
				firstDispatchedAt: now,
			});
		});
		const first = await service.create(userId, workspaceId, 'WORKSPACE_DEMO', clientKey);
		expect(first.statusCode).toBe(201);
		publicContract(first.payment, { id: first.payment.id, status: 'PENDING' });
		const second = await service.create(userId, workspaceId, 'WORKSPACE_DEMO', clientKey);
		expect(second.statusCode).toBe(200);
		expect(second.payment.id).toBe(first.payment.id);
		publicContract(second.payment, { id: first.payment.id, status: 'PENDING' });
		expect(payment.create).toHaveBeenCalledTimes(1);
		expect(recover).toHaveBeenCalledTimes(1);
		expect(payment.findUniqueOrThrow).toHaveBeenCalledTimes(1);
		for (const [query] of [
			...payment.findUnique.mock.calls,
			...payment.findUniqueOrThrow.mock.calls,
			...payment.create.mock.calls,
		]) {
			expect(query.select).toBeDefined();
			for (const field of ['providerRequest', 'providerIdempotenceKey', 'leaseToken'] as const)
				expect(query.select?.[field]).not.toBe(true);
		}
	});

	it('returns 202 with the same safe fields while provider creation remains unresolved', async () => {
		rows.clear();
		jest.spyOn(recovery, 'recover').mockResolvedValue(undefined);
		const result = await service.create(userId, workspaceId, 'WORKSPACE_DEMO', clientKey);
		expect(result.statusCode).toBe(202);
		publicContract(result.payment, { id: result.payment.id, status: 'CREATED' });
	});

	it('returns 201 for a known operation requiring manual review while masking its Checkout link', async () => {
		rows.clear();
		jest.spyOn(recovery, 'recover').mockImplementation(async (id) => {
			const row = rows.get(id);
			if (!row) throw new Error('Missing reserved payment');
			rows.set(id, {
				...row,
				status: 'PENDING',
				providerPaymentId: 'cs_test_review',
				needsReview: true,
				lastErrorCode: 'PROVIDER_INVALID_RESPONSE',
			});
		});
		const result = await service.create(userId, workspaceId, 'WORKSPACE_DEMO', clientKey);
		expect(result.statusCode).toBe(201);
		publicContract(result.payment, { id: result.payment.id, status: 'PENDING' });
		expect(result.payment).toMatchObject({
			confirmationUrl: null,
			needsReview: true,
			lastErrorCode: 'PROVIDER_INVALID_RESPONSE',
		});
	});

	it('keeps an unknown provider outcome at 202 even when it needs manual review', async () => {
		rows.clear();
		jest.spyOn(recovery, 'recover').mockImplementation(async (id) => {
			const row = rows.get(id);
			if (!row) throw new Error('Missing reserved payment');
			rows.set(id, { ...row, status: 'CREATED', providerPaymentId: null, needsReview: true });
		});
		const result = await service.create(userId, workspaceId, 'WORKSPACE_DEMO', clientKey);
		expect(result.statusCode).toBe(202);
		publicContract(result.payment, { id: result.payment.id, status: 'CREATED' });
		expect(result.payment).toMatchObject({ confirmationUrl: null, needsReview: true });
	});

	it('reads a fresh public projection after reconciliation instead of returning its internal work state', async () => {
		const recover = jest.spyOn(recovery, 'recover').mockImplementation(async (id) => {
			const row = rows.get(id);
			if (!row) throw new Error('Missing payment to reconcile');
			rows.set(id, { ...row, status: 'SUCCEEDED' });
		});
		const result = await service.reconcile(userId, paymentId);
		expect(recover).toHaveBeenCalledWith(paymentId);
		publicContract(result, { id: paymentId, status: 'SUCCEEDED' });
		expect(result.confirmationUrl).toBeNull();
		for (const [query] of [
			...payment.findUnique.mock.calls,
			...payment.findUniqueOrThrow.mock.calls,
		])
			publicSelection(query.select);
	});

	it('does not return a projected row or query history after access is rejected', async () => {
		access.requireWorkspace.mockRejectedValue(new ForbiddenException());
		await expect(service.get(userId, paymentId)).rejects.toBeInstanceOf(ForbiddenException);
		await expect(service.history(userId, workspaceId, 5)).rejects.toBeInstanceOf(
			ForbiddenException,
		);
		expect(payment.findMany).not.toHaveBeenCalled();
	});
});

describe('Task 8 void transition commands (no DB/network)', () => {
	let module: TestingModule;
	let transitions: PaymentTransitionService;
	const tx = {
		payment: { findUnique: jest.fn(), update: jest.fn() },
		paymentAudit: { create: jest.fn() },
	};
	const transaction = jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
	const snapshot = (status: PaymentProviderSnapshot['status']): PaymentProviderSnapshot => ({
		provider: 'stripe',
		id: 'cs_test_private_id',
		status,
		test: true,
		amountMinor: 1_000,
		currency: 'USD',
		metadata: { paymentId, workspaceId },
		clientReferenceId: paymentId,
		confirmationUrl: null,
	});
	beforeEach(async () => {
		jest.clearAllMocks();
		tx.payment.findUnique.mockReset();
		tx.payment.update.mockReset();
		tx.paymentAudit.create.mockResolvedValue({});
		module = await Test.createTestingModule({
			providers: [
				PaymentTransitionService,
				{ provide: PrismaService, useValue: { $transaction: transaction } },
				{ provide: StripePaymentProvider, useValue: { validateContext: jest.fn() } },
			],
		}).compile();
		transitions = module.get(PaymentTransitionService);
	});
	afterEach(async () => module.close());

	it('stops after one successful command transaction and writes one audit transition', async () => {
		tx.payment.findUnique.mockResolvedValue(
			fixture({ status: 'CREATED', providerPaymentId: null }),
		);
		tx.payment.update.mockResolvedValue({ id: paymentId });
		await expect(
			transitions.apply(paymentId, snapshot('succeeded'), {
				reason: 'VERIFIED_WEBHOOK',
				correlationId: 'response-test',
			}),
		).resolves.toBeUndefined();
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(tx.payment.update).toHaveBeenCalledTimes(1);
		expect(tx.paymentAudit.create).toHaveBeenCalledTimes(1);
		expect(tx.paymentAudit.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ paymentId, fromStatus: 'CREATED', toStatus: 'SUCCEEDED' }),
		});
	});

	it('retries a lost CAS with a fresh row and preserves the terminal status won by another transaction', async () => {
		tx.payment.findUnique
			.mockResolvedValueOnce(fixture({ status: 'CREATED', version: 1 }))
			.mockResolvedValueOnce(fixture({ status: 'SUCCEEDED', version: 2 }));
		tx.payment.update
			.mockRejectedValueOnce(
				new Prisma.PrismaClientKnownRequestError('Payment version changed', {
					code: 'P2025',
					clientVersion: Prisma.prismaVersion.client,
				}),
			)
			.mockResolvedValueOnce({ id: paymentId });
		await expect(
			transitions.apply(paymentId, snapshot('pending'), {
				reason: 'CREATE_RESPONSE',
				correlationId: 'response-test',
			}),
		).resolves.toBeUndefined();
		expect(transaction).toHaveBeenCalledTimes(2);
		expect(tx.payment.findUnique).toHaveBeenCalledTimes(2);
		expect(tx.payment.update.mock.calls[1][0]).toMatchObject({
			where: { id: paymentId, version: 2 },
			data: { status: 'SUCCEEDED' },
		});
		expect(tx.paymentAudit.create).not.toHaveBeenCalled();
	});

	it('keeps a defensive unsupported normalized state nonterminal and requests review', async () => {
		tx.payment.findUnique.mockResolvedValue(
			fixture({ status: 'CREATED', providerPaymentId: null }),
		);
		tx.payment.update.mockResolvedValue({ id: paymentId });
		const unexpected = {
			...snapshot('pending'),
			status: 'unsupported' as PaymentProviderSnapshot['status'],
		};
		await transitions.apply(paymentId, unexpected, {
			reason: 'RECONCILE',
			correlationId: 'response-test',
		});
		expect(tx.payment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: 'CREATED',
					needsReview: true,
					lastErrorCode: 'PROVIDER_UNSUPPORTED_STATE',
				}),
			}),
		);
		expect(tx.paymentAudit.create).not.toHaveBeenCalled();
	});
});
