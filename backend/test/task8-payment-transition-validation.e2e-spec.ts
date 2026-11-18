import { Payment, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import {
	PaymentTransitionService,
	terminalPayment,
} from '../src/payments/payment-transition.service';
import { PaymentProviderError, PaymentProviderSnapshot } from '../src/payments/payment-provider';
import { StripePaymentProvider } from '../src/payments/stripe-payment.provider';
import { isolatedConfig } from './test-config';

describe('Task 8 verified payment identity (no DB)', () => {
	const now = new Date('2026-11-15T09:00:00Z');
	const payment: Payment = {
		id: '77fb35cf-58e6-4fca-bbd0-3478d7aa0cb6',
		workspaceId: 'workspace-one',
		userId: 'owner-one',
		purpose: 'WORKSPACE_DEMO',
		provider: 'stripe',
		amountMinor: 1_000,
		currency: 'USD',
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
	const snapshot: PaymentProviderSnapshot = {
		provider: 'stripe',
		id: 'cs_test_operation_one',
		status: 'succeeded',
		test: true,
		amountMinor: 1_000,
		currency: 'USD',
		metadata: { paymentId: payment.id, workspaceId: payment.workspaceId },
		clientReferenceId: payment.id,
		confirmationUrl: null,
	};
	const provider = new StripePaymentProvider(isolatedConfig(), 'http://127.0.0.1:1');
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

	it.each<{ name: string; input: unknown; code: string }>([
		{ name: 'live object', input: { ...snapshot, test: false }, code: 'PROVIDER_MODE_MISMATCH' },
		{
			name: 'snapshot from another provider',
			input: { ...snapshot, provider: 'yookassa' },
			code: 'PROVIDER_MODE_MISMATCH',
		},
		{
			name: 'different amount',
			input: { ...snapshot, amountMinor: 1_001 },
			code: 'PROVIDER_AMOUNT_MISMATCH',
		},
		{
			name: 'different currency',
			input: { ...snapshot, currency: 'RUB' },
			code: 'PROVIDER_AMOUNT_MISMATCH',
		},
		{
			name: 'different local ID',
			input: {
				...snapshot,
				clientReferenceId: 'different',
				metadata: { ...snapshot.metadata, paymentId: 'different' },
			},
			code: 'PROVIDER_METADATA_MISMATCH',
		},
		{
			name: 'different workspace',
			input: { ...snapshot, metadata: { ...snapshot.metadata, workspaceId: 'different' } },
			code: 'PROVIDER_METADATA_MISMATCH',
		},
		{
			name: 'client reference inconsistent with metadata',
			input: { ...snapshot, clientReferenceId: 'different' },
			code: 'PROVIDER_REFERENCE_MISMATCH',
		},
		{
			name: 'path-like ID',
			input: { ...snapshot, id: '../payments/other' },
			code: 'PROVIDER_INVALID_ID',
		},
	])('refuses $name without trusting a succeeded label', ({ input, code }) => {
		expect(() => transitions.validate(payment, input as PaymentProviderSnapshot)).toThrow(
			PaymentProviderError,
		);
		expect(() => transitions.validate(payment, input as PaymentProviderSnapshot)).toThrow(code);
	});

	it('refuses to apply a current Stripe snapshot to an older YooKassa payment', () => {
		expect(() => transitions.validate({ ...payment, provider: 'yookassa' }, snapshot)).toThrow(
			'PROVIDER_MISMATCH',
		);
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
