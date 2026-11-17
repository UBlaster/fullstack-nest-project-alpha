import { Payment, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import {
	PaymentTransitionService,
	terminalPayment,
} from '../src/payments/payment-transition.service';
import {
	PaymentProviderError,
	YooKassaPaymentProvider,
	YooKassaSnapshot,
} from '../src/payments/yookassa-payment.provider';
import { isolatedConfig } from './test-config';

describe('Task 8 verified payment identity (no DB)', () => {
	const now = new Date('2026-11-15T09:00:00Z');
	const payment: Payment = {
		id: '77fb35cf-58e6-4fca-bbd0-3478d7aa0cb6',
		workspaceId: 'workspace-one',
		userId: 'owner-one',
		purpose: 'WORKSPACE_DEMO',
		amountMinor: 10_000,
		currency: 'RUB',
		status: PaymentStatus.CREATED,
		providerPaymentId: null,
		confirmationUrl: null,
		idempotencyKey: 'caa08a5c-3406-4e36-a700-a1bdf1477b93',
		requestHash: 'request-fingerprint',
		providerIdempotenceKey: '5825d2ee-3539-4d10-9c8a-4d82aeea6fcf',
		providerRequest: {},
		firstDispatchedAt: now,
		createAttempts: 1,
		version: 0,
		needsReview: false,
		lastErrorCode: null,
		nextReconcileAt: now,
		reconcileAttempts: 0,
		leaseToken: null,
		leaseUntil: null,
		createdAt: now,
		updatedAt: now,
	};
	const snapshot: YooKassaSnapshot = {
		id: 'provider-one',
		status: 'succeeded',
		test: true,
		amount: { value: '100.00', currency: 'RUB' },
		recipient: { account_id: '123456' },
		metadata: { paymentId: payment.id, workspaceId: payment.workspaceId },
	};
	const provider = new YooKassaPaymentProvider(
		isolatedConfig({ YOOKASSA_SHOP_ID: '123456' }),
		'http://127.0.0.1:1',
	);
	// validate is intentionally pure; a real DB client is never instantiated or connected.
	const transitions = new PaymentTransitionService({} as PrismaService, provider);

	it('accepts a verified early webhook before the provider ID has been bound', () => {
		expect(() => transitions.validate(payment, snapshot)).not.toThrow();
	});

	it('accepts the same ID after binding but refuses a different provider operation', () => {
		expect(() =>
			transitions.validate({ ...payment, providerPaymentId: snapshot.id }, snapshot),
		).not.toThrow();
		expect(() =>
			transitions.validate({ ...payment, providerPaymentId: 'different' }, snapshot),
		).toThrow('PROVIDER_ID_MISMATCH');
	});

	it.each([
		['live object', { ...snapshot, test: false }, 'PROVIDER_SHOP_OR_MODE_MISMATCH'],
		[
			'different shop',
			{ ...snapshot, recipient: { account_id: '654321' } },
			'PROVIDER_SHOP_OR_MODE_MISMATCH',
		],
		[
			'different amount',
			{ ...snapshot, amount: { value: '100.01', currency: 'RUB' } },
			'PROVIDER_AMOUNT_MISMATCH',
		],
		[
			'different currency',
			{ ...snapshot, amount: { value: '100.00', currency: 'USD' } },
			'PROVIDER_AMOUNT_MISMATCH',
		],
		[
			'different local ID',
			{ ...snapshot, metadata: { ...snapshot.metadata, paymentId: 'different' } },
			'PROVIDER_METADATA_MISMATCH',
		],
		[
			'different workspace',
			{ ...snapshot, metadata: { ...snapshot.metadata, workspaceId: 'different' } },
			'PROVIDER_METADATA_MISMATCH',
		],
		['path-like ID', { ...snapshot, id: '../payments/other' }, 'PROVIDER_INVALID_ID'],
	])('refuses %s without trusting a succeeded label', (_name, input, code) => {
		expect(() => transitions.validate(payment, input as YooKassaSnapshot)).toThrow(
			PaymentProviderError,
		);
		expect(() => transitions.validate(payment, input as YooKassaSnapshot)).toThrow(code as string);
	});

	it.each([
		[PaymentStatus.CREATED, false],
		[PaymentStatus.PENDING, false],
		[PaymentStatus.SUCCEEDED, true],
		[PaymentStatus.CANCELLED, true],
		[PaymentStatus.FAILED, true],
	])('identifies terminal status %s as %s', (status, terminal) => {
		expect(terminalPayment(status)).toBe(terminal);
	});
});
