import { ForbiddenException, MessageEvent, NotFoundException } from '@nestjs/common';
import { AccessPolicyService } from '../src/access/access-policy.service';
import { PaymentRecoveryService } from '../src/payments/payment-recovery.service';
import { paymentResponseSelect, PaymentResponseRow } from '../src/payments/payment-response.select';
import {
	PAYMENT_EVENTS_DURATION_MS,
	PAYMENT_EVENTS_INTERVAL_MS,
	PaymentsService,
} from '../src/payments/payments.service';
import { StripePaymentProvider } from '../src/payments/stripe-payment.provider';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Task 8 payment SSE observation (no DB/network)', () => {
	let row: PaymentResponseRow;
	let service: PaymentsService;
	const payment = { findUnique: jest.fn() };
	const access = { requireWorkspace: jest.fn() };

	beforeEach(() => {
		jest.useFakeTimers();
		jest.resetAllMocks();
		row = {
			id: 'a812c5d1-20cc-4f81-829c-aad4bcb6c8e3',
			workspaceId: 'events-workspace',
			purpose: 'WORKSPACE_DEMO',
			provider: 'stripe',
			amountMinor: 1_000,
			currency: 'USD',
			status: 'PENDING',
			confirmationUrl: 'https://checkout.stripe.com/c/pay/test_events',
			needsReview: false,
			lastErrorCode: null,
			createdAt: new Date('2026-11-18T00:00:00Z'),
			updatedAt: new Date('2026-11-18T00:00:00Z'),
		};
		payment.findUnique.mockImplementation(async () => ({ ...row }));
		service = new PaymentsService(
			{ payment } as unknown as PrismaService,
			access as unknown as AccessPolicyService,
			{} as StripePaymentProvider,
			{} as PaymentRecoveryService,
		);
	});

	afterEach(() => {
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	it('immediately emits the public snapshot and ignores timestamp-only writes', async () => {
		const received: MessageEvent[] = [];
		const subscription = (await service.events('owner', row.id)).subscribe((event) =>
			received.push(event),
		);
		expect(received).toEqual([{ type: 'payment', data: row }]);
		row.updatedAt = new Date();
		await jest.advanceTimersByTimeAsync(PAYMENT_EVENTS_INTERVAL_MS * 2);
		expect(received).toHaveLength(1);
		expect(payment.findUnique).toHaveBeenCalledTimes(3);
		for (const [query] of payment.findUnique.mock.calls) {
			expect(query).toEqual({ where: { id: row.id }, select: paymentResponseSelect });
		}
		expect(access.requireWorkspace).toHaveBeenCalledTimes(3);
		subscription.unsubscribe();
	});

	it('reads changed state without a local signal and completes after the saved terminal status', async () => {
		const received: MessageEvent[] = [];
		const completed = jest.fn();
		(await service.events('owner', row.id)).subscribe({
			next: (event) => received.push(event),
			complete: completed,
		});
		row = { ...row, status: 'SUCCEEDED' };
		await jest.advanceTimersByTimeAsync(PAYMENT_EVENTS_INTERVAL_MS);
		expect(received).toHaveLength(2);
		expect(received[1]).toMatchObject({
			type: 'payment',
			data: { status: 'SUCCEEDED', confirmationUrl: null },
		});
		expect(completed).toHaveBeenCalledTimes(1);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('reconnect immediately reads a transition made while disconnected', async () => {
		const first = (await service.events('owner', row.id)).subscribe();
		first.unsubscribe();
		row = { ...row, needsReview: true, lastErrorCode: 'PROVIDER_AMOUNT_MISMATCH' };
		const received: MessageEvent[] = [];
		const second = (await service.events('owner', row.id)).subscribe((event) =>
			received.push(event),
		);
		expect(received).toEqual([{ type: 'payment', data: { ...row, confirmationUrl: null } }]);
		expect(second.closed).toBe(true);
		expect(jest.getTimerCount()).toBe(0);
	});

	it.each(['SUCCEEDED', 'CANCELLED', 'FAILED'] as const)(
		'emits an initial %s snapshot once and closes',
		async (status) => {
			row.status = status;
			const received: MessageEvent[] = [];
			const subscription = (await service.events('owner', row.id)).subscribe((event) =>
				received.push(event),
			);
			expect(received).toHaveLength(1);
			expect(subscription.closed).toBe(true);
			expect(jest.getTimerCount()).toBe(0);
		},
	);

	it('never overlaps reads and ignores an in-flight result after unsubscribe', async () => {
		const received: MessageEvent[] = [];
		const subscription = (await service.events('owner', row.id)).subscribe((event) =>
			received.push(event),
		);
		let resolveRead: (value: PaymentResponseRow) => void = () => {};
		payment.findUnique.mockImplementation(
			() => new Promise<PaymentResponseRow>((resolve) => (resolveRead = resolve)),
		);
		await jest.advanceTimersByTimeAsync(PAYMENT_EVENTS_INTERVAL_MS * 4);
		expect(payment.findUnique).toHaveBeenCalledTimes(2);
		subscription.unsubscribe();
		resolveRead({ ...row, status: 'SUCCEEDED' });
		await jest.advanceTimersByTimeAsync(PAYMENT_EVENTS_INTERVAL_MS * 2);
		expect(received).toHaveLength(1);
		expect(payment.findUnique).toHaveBeenCalledTimes(2);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('enforces the subscription deadline even during a stalled read', async () => {
		const subscription = (await service.events('owner', row.id)).subscribe();
		payment.findUnique.mockImplementation(() => new Promise(() => {}));
		await jest.advanceTimersByTimeAsync(PAYMENT_EVENTS_DURATION_MS);
		expect(subscription.closed).toBe(true);
		expect(jest.getTimerCount()).toBe(0);
	});

	it.each([403, 404])('rejects access before opening a stream with HTTP %i', async (status) => {
		const failure = status === 403 ? new ForbiddenException() : new NotFoundException();
		access.requireWorkspace.mockRejectedValue(failure);
		await expect(service.events('outsider', row.id)).rejects.toBe(failure);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('stops without another payment event when membership is revoked', async () => {
		const received: MessageEvent[] = [];
		const subscription = (await service.events('owner', row.id)).subscribe((event) =>
			received.push(event),
		);
		access.requireWorkspace.mockRejectedValue(new NotFoundException());
		row.status = 'SUCCEEDED';
		await jest.advanceTimersByTimeAsync(PAYMENT_EVENTS_INTERVAL_MS);
		expect(received).toHaveLength(2);
		expect(received[1]).toEqual({ type: 'payment-error', data: { statusCode: 404 } });
		expect(subscription.closed).toBe(true);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('does not expose database error messages', async () => {
		const received: MessageEvent[] = [];
		(await service.events('owner', row.id)).subscribe((event) => received.push(event));
		payment.findUnique.mockRejectedValue(new Error('private connection details'));
		await jest.advanceTimersByTimeAsync(PAYMENT_EVENTS_INTERVAL_MS);
		expect(received[1]).toEqual({ type: 'payment-error', data: { statusCode: 503 } });
		expect(jest.getTimerCount()).toBe(0);
	});
});
