import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Payment, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
	isProviderId,
	PaymentProviderError,
	YooKassaPaymentProvider,
	YooKassaSnapshot,
} from './yookassa-payment.provider';

export interface PaymentEventKey {
	eventType: string;
	providerObjectId: string;
	leaseToken?: string;
}

class PaymentCompareAndSwapError extends Error {}

export function terminalPayment(status: PaymentStatus): boolean {
	return (
		status === PaymentStatus.SUCCEEDED ||
		status === PaymentStatus.CANCELLED ||
		status === PaymentStatus.FAILED
	);
}

@Injectable()
export class PaymentTransitionService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly provider: YooKassaPaymentProvider,
	) {}

	validate(payment: Payment, snapshot: YooKassaSnapshot): void {
		this.provider.validateShop(snapshot);
		if (!isProviderId(snapshot.id)) throw new PaymentProviderError('PROVIDER_INVALID_ID');
		if (payment.providerPaymentId && payment.providerPaymentId !== snapshot.id) {
			throw new PaymentProviderError('PROVIDER_ID_MISMATCH');
		}
		const amount = `${Math.floor(payment.amountMinor / 100)}.${String(payment.amountMinor % 100).padStart(2, '0')}`;
		if (snapshot.amount.value !== amount || snapshot.amount.currency !== payment.currency) {
			throw new PaymentProviderError('PROVIDER_AMOUNT_MISMATCH');
		}
		if (
			snapshot.metadata.paymentId !== payment.id ||
			snapshot.metadata.workspaceId !== payment.workspaceId
		) {
			throw new PaymentProviderError('PROVIDER_METADATA_MISMATCH');
		}
	}

	async apply(
		id: string,
		snapshot: YooKassaSnapshot,
		reason: string,
		correlationId: string,
		event?: PaymentEventKey,
		leaseToken?: string,
	): Promise<void> {
		if (event && event.providerObjectId !== snapshot.id) {
			throw new PaymentProviderError('PROVIDER_ID_MISMATCH');
		}
		for (let attempt = 0; attempt < 8; attempt += 1) {
			try {
				await this.prisma.$transaction(async (tx) => {
					const payment = await tx.payment.findUnique({ where: { id } });
					if (!payment) throw new PaymentProviderError('PAYMENT_NOT_FOUND');
					this.validate(payment, snapshot);
					const now = new Date();
					if (
						leaseToken !== undefined &&
						(payment.leaseToken !== leaseToken || !payment.leaseUntil || payment.leaseUntil <= now)
					) {
						throw new PaymentProviderError('PAYMENT_LEASE_LOST');
					}
					// Every event application locks/asserts the event before mutating Payment.
					// A CAS retry rolls this preparatory upsert back with the whole transaction.
					if (event) await this.recordEvent(tx, event, id, 'RETRY_PENDING');
					const incoming = this.statusFor(snapshot.status);
					const terminal = terminalPayment(payment.status);
					const conflict =
						terminal &&
						(payment.status === PaymentStatus.FAILED ||
							(incoming !== null && terminalPayment(incoming) && incoming !== payment.status));
					const stale = terminal && (incoming === PaymentStatus.PENDING || incoming === null);
					const status = terminal || incoming === null ? payment.status : incoming;
					const needsReview = conflict || incoming === null || (stale && payment.needsReview);
					const lastErrorCode = conflict
						? 'PROVIDER_TERMINAL_CONFLICT'
						: incoming === null
							? 'PROVIDER_WAITING_FOR_CAPTURE'
							: stale
								? payment.lastErrorCode
								: null;
					const changed = await tx.payment.updateMany({
						where: {
							id,
							version: payment.version,
							...(leaseToken !== undefined ? { leaseToken, leaseUntil: { gt: now } } : {}),
						},
						data: {
							providerPaymentId: snapshot.id,
							confirmationUrl: terminalPayment(status)
								? null
								: (snapshot.confirmation?.confirmation_url ?? payment.confirmationUrl),
							status,
							needsReview,
							lastErrorCode,
							version: { increment: 1 },
						},
					});
					if (changed.count === 0) throw new PaymentCompareAndSwapError();
					if (status !== payment.status) {
						await tx.paymentAudit.create({
							data: {
								paymentId: id,
								fromStatus: payment.status,
								toStatus: status,
								reason,
								correlationId,
							},
						});
					}
					if (event) {
						await this.recordEvent(
							tx,
							event,
							id,
							terminal || (incoming !== null && terminalPayment(incoming))
								? conflict || stale
									? 'IGNORED'
									: 'APPLIED'
								: 'RETRY_PENDING',
							lastErrorCode,
						);
					}
				});
				return;
			} catch (error: unknown) {
				if (error instanceof PaymentCompareAndSwapError) continue;
				if (error instanceof Prisma.PrismaClientKnownRequestError) {
					if (error.code === 'P2034') continue;
					if (error.code === 'P2002') throw new PaymentProviderError('PROVIDER_ID_ALREADY_BOUND');
				}
				throw error;
			}
		}
		throw new PaymentProviderError('PAYMENT_CONCURRENT_UPDATE');
	}

	async recordEvent(
		tx: Prisma.TransactionClient,
		event: PaymentEventKey,
		paymentId: string | null,
		result: string,
		errorCode: string | null = null,
	): Promise<void> {
		const now = new Date();
		const processedAt = result === 'APPLIED' || result === 'IGNORED' ? now : null;
		const nextReconcileAt = new Date(now.getTime() + 60_000);
		const eventLeaseToken = event.leaseToken ?? null;
		// Atomic ON CONFLICT also protects an event with no Payment row to serialize on.
		// A late pending handler cannot reopen a completed event or release another claim.
		const affected = await tx.$executeRaw`
			INSERT INTO "PaymentEvent" (
				"id", "provider", "eventType", "providerObjectId", "paymentId", "result",
				"errorCode", "processedAt", "nextReconcileAt", "createdAt", "updatedAt"
			) SELECT
				${randomUUID()}::uuid, 'yookassa', ${event.eventType}, ${event.providerObjectId},
				${paymentId}::uuid, ${result}, ${errorCode}, ${processedAt}, ${nextReconcileAt}, ${now}, ${now}
			WHERE ${eventLeaseToken}::uuid IS NULL OR EXISTS (
				SELECT 1 FROM "PaymentEvent" AS existing
				WHERE existing."provider" = 'yookassa'
					AND existing."eventType" = ${event.eventType}
					AND existing."providerObjectId" = ${event.providerObjectId}
					AND existing."leaseToken" = ${eventLeaseToken}::uuid
					AND existing."leaseUntil" > clock_timestamp()
			)
			ON CONFLICT ("provider", "eventType", "providerObjectId") DO UPDATE SET
				"paymentId" = COALESCE("PaymentEvent"."paymentId", EXCLUDED."paymentId"),
				"result" = CASE WHEN "PaymentEvent"."processedAt" IS NOT NULL
					THEN "PaymentEvent"."result" ELSE EXCLUDED."result" END,
				"errorCode" = CASE WHEN "PaymentEvent"."processedAt" IS NOT NULL
					THEN "PaymentEvent"."errorCode" ELSE EXCLUDED."errorCode" END,
				"processedAt" = COALESCE("PaymentEvent"."processedAt", EXCLUDED."processedAt"),
				"nextReconcileAt" = GREATEST("PaymentEvent"."nextReconcileAt", EXCLUDED."nextReconcileAt"),
				"updatedAt" = EXCLUDED."updatedAt"
			WHERE ${eventLeaseToken}::uuid IS NULL OR (
				"PaymentEvent"."leaseToken" = ${eventLeaseToken}::uuid
				AND "PaymentEvent"."leaseUntil" > clock_timestamp()
			)
		`;
		if (affected === 0 && eventLeaseToken !== null) {
			throw new PaymentProviderError('PAYMENT_EVENT_LEASE_LOST');
		}
	}

	private statusFor(status: YooKassaSnapshot['status']): PaymentStatus | null {
		if (status === 'succeeded') return PaymentStatus.SUCCEEDED;
		if (status === 'canceled') return PaymentStatus.CANCELLED;
		if (status === 'pending') return PaymentStatus.PENDING;
		return null;
	}
}
