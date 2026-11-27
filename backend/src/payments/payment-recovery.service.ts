import { randomUUID } from 'node:crypto';
import { PaymentStatus, Prisma } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { getRequestId, runWithRequestId } from '../diagnostics/request-context';
import { logEvent } from '../observability/logger';
import { meter, withSpan } from '../observability/telemetry';
import { PrismaService } from '../prisma/prisma.service';
import {
	isInvalidPaymentSnapshot,
	paymentErrorCode,
	PaymentProviderError,
	WORKSPACE_PAYMENT_PRICE,
} from './payment-provider';
import { PaymentTransitionService, terminalPayment } from './payment-transition.service';
import { updateCurrent } from './update-current';
import { StripePaymentProvider } from './stripe-payment.provider';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const CREATE_WINDOW_MS = 23 * HOUR_MS;
const activeStatuses: PaymentStatus[] = ['CREATED', 'PENDING'];
const reconciliations = meter.createCounter('payment.reconciliations');

const recoverySelect = {
	id: true,
	status: true,
	needsReview: true,
	providerPaymentId: true,
	providerIdempotenceKey: true,
	providerRequest: true,
	firstDispatchedAt: true,
	reconcileAttempts: true,
	leaseUntil: true,
} satisfies Prisma.PaymentSelect;

type RecoveryPayment = Prisma.PaymentGetPayload<{ select: typeof recoverySelect }>;

export function paymentBackoff(attempts: number): number {
	return Math.min(MINUTE_MS * 2 ** Math.min(attempts, 6), HOUR_MS);
}

function activeLease(id: string, leaseToken: string, at = new Date()) {
	return { id, leaseToken, leaseUntil: { gt: at } };
}

@Injectable()
export class PaymentRecoveryService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly provider: StripePaymentProvider,
		private readonly transitions: PaymentTransitionService,
	) {}

	isConfigured(): boolean {
		return this.provider.isConfigured();
	}

	leaseDurationMs(): number {
		return this.provider.httpTimeoutMs() + 10_000;
	}

	recover(
		id: string,
		dueAt?: Date,
		source: 'manual' | 'create' | 'scheduled' = dueAt ? 'scheduled' : 'manual',
	): Promise<void> {
		const operation = source === 'create' ? 'payment.dispatch' : 'payment.reconcile';
		const observe = () =>
			withSpan(
				operation,
				async (span) => {
					let result = 'error';
					try {
						result = await this.recoverPayment(id, dueAt);
					} finally {
						span.setAttribute('payment.result', result);
						logEvent(result === 'error' ? 'warn' : 'info', operation, {
							paymentId: id,
							source,
							result,
						});
						if (source !== 'create') reconciliations.add(1, { source, result });
					}
				},
				{ attributes: { 'payment.id': id, 'payment.source': source } },
			);
		return getRequestId() ? observe() : runWithRequestId(undefined, observe);
	}

	private async recoverPayment(id: string, dueAt?: Date) {
		this.provider.assertConfigured();
		const leaseToken = randomUUID();
		const claimed = await this.claim(id, leaseToken, dueAt);
		if (!claimed) return 'skipped';

		try {
			return await this.recoverClaim(claimed, leaseToken);
		} catch (error: unknown) {
			await this.recordFailure(id, leaseToken, error);
			if (!(error instanceof PaymentProviderError)) throw error;
			return 'deferred';
		} finally {
			const now = new Date();
			await updateCurrent(
				this.prisma.payment.update({
					where: activeLease(id, leaseToken, now),
					data: {
						leaseToken: null,
						leaseUntil: null,
						reconcileAttempts: { increment: 1 },
						nextReconcileAt: new Date(now.getTime() + paymentBackoff(claimed.reconcileAttempts)),
					},
					select: { id: true },
				}),
			);
		}
	}

	private claim(id: string, leaseToken: string, dueAt?: Date) {
		const now = new Date();
		return updateCurrent(
			this.prisma.payment.update({
				where: {
					id,
					provider: WORKSPACE_PAYMENT_PRICE.provider,
					nextReconcileAt: dueAt ? { lte: dueAt } : undefined,
					OR: [
						{ status: { in: activeStatuses } },
						{ needsReview: true, providerPaymentId: { not: null } },
					],
					AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }],
				},
				data: {
					leaseToken,
					leaseUntil: new Date(now.getTime() + this.leaseDurationMs()),
					version: { increment: 1 },
				},
				select: recoverySelect,
			}),
		);
	}

	private async recoverClaim(claimed: RecoveryPayment, leaseToken: string) {
		const payment = claimed.providerPaymentId
			? claimed
			: await this.prepareCreate(claimed, leaseToken);
		if (!payment?.leaseUntil || payment.leaseUntil <= new Date()) return 'skipped';

		const { id, providerPaymentId, providerRequest, providerIdempotenceKey, firstDispatchedAt } =
			payment;
		if (terminalPayment(payment.status) && !payment.needsReview) return 'skipped';
		if (
			!providerPaymentId &&
			(!firstDispatchedAt || Date.now() - firstDispatchedAt.getTime() >= CREATE_WINDOW_MS)
		)
			return 'skipped';

		const snapshot = providerPaymentId
			? await this.provider.get(providerPaymentId)
			: await this.provider.create(providerRequest, providerIdempotenceKey);
		await this.transitions.apply(id, snapshot, {
			reason: providerPaymentId ? 'RECONCILE' : 'CREATE_RESPONSE',
			correlationId: leaseToken,
			leaseToken,
		});
		return 'verified';
	}

	private async prepareCreate(payment: RecoveryPayment, leaseToken: string) {
		const now = new Date();
		const cutoff = new Date(now.getTime() - CREATE_WINDOW_MS);
		const current = {
			...activeLease(payment.id, leaseToken, now),
			AND: [{ providerPaymentId: null }],
			status: { in: activeStatuses },
		};
		if (payment.firstDispatchedAt && payment.firstDispatchedAt <= cutoff) {
			await updateCurrent(
				this.prisma.payment.update({
					where: { ...current, firstDispatchedAt: { lte: cutoff } },
					data: {
						needsReview: true,
						lastErrorCode: 'PROVIDER_CREATE_WINDOW_EXPIRED',
						version: { increment: 1 },
					},
					select: { id: true },
				}),
			);
			return null;
		}
		return updateCurrent(
			this.prisma.payment.update({
				where: {
					...current,
					OR: [{ firstDispatchedAt: null }, { firstDispatchedAt: { gt: cutoff } }],
				},
				data: {
					firstDispatchedAt: payment.firstDispatchedAt ?? now,
					createAttempts: { increment: 1 },
					version: { increment: 1 },
				},
				select: recoverySelect,
			}),
		);
	}

	private async recordFailure(id: string, leaseToken: string, error: unknown) {
		const code = paymentErrorCode(error);
		const needsReview = isInvalidPaymentSnapshot(error) || /^PROVIDER_HTTP_4\d\d$/.test(code);
		await updateCurrent(
			this.prisma.payment.update({
				where: { ...activeLease(id, leaseToken), status: { in: activeStatuses } },
				data: {
					lastErrorCode: code,
					...(needsReview ? { needsReview: true } : {}),
					version: { increment: 1 },
				},
				select: { id: true },
			}),
		);
	}
}
