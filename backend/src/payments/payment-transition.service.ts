import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Payment, PaymentStatus, Prisma } from '@prisma/client';
import { logEvent } from '../observability/logger';
import { withSpan } from '../observability/telemetry';
import { PrismaService } from '../prisma/prisma.service';
import {
	isProviderId,
	PaymentProviderError,
	PaymentProviderSnapshot,
	WORKSPACE_PAYMENT_PRICE,
} from './payment-provider';
import { StripePaymentProvider } from './stripe-payment.provider';

const MAX_TRANSACTION_ATTEMPTS = 8;

export interface PaymentEventKey {
	eventType: string;
	providerObjectId: string;
	leaseToken?: string;
}

type EventResult = 'UNMATCHED' | 'RETRY_PENDING' | 'APPLIED' | 'IGNORED';

interface EventOutcome {
	result: EventResult;
	paymentId?: string | null;
	errorCode?: string | null;
}

interface TransitionContext {
	reason: 'CREATE_RESPONSE' | 'RECONCILE' | 'VERIFIED_WEBHOOK';
	correlationId: string;
	event?: PaymentEventKey;
	leaseToken?: string;
}

interface PaymentTransition {
	status: PaymentStatus;
	needsReview: boolean;
	lastErrorCode: string | null;
	eventResult: EventResult;
}

export function terminalPayment(status: PaymentStatus): boolean {
	return status === 'SUCCEEDED' || status === 'CANCELLED' || status === 'FAILED';
}

function snapshotStatus(status: PaymentProviderSnapshot['status']): PaymentStatus | null {
	switch (status) {
		case 'pending':
			return 'PENDING';
		case 'succeeded':
			return 'SUCCEEDED';
		case 'canceled':
			return 'CANCELLED';
		default:
			return null;
	}
}

function planTransition(payment: Payment, incoming: PaymentStatus | null): PaymentTransition {
	const current = payment.status;
	const terminal = terminalPayment(current);

	if (
		terminal &&
		(current === 'FAILED' || (incoming && terminalPayment(incoming) && incoming !== current))
	) {
		return {
			status: current,
			needsReview: true,
			lastErrorCode: 'PROVIDER_TERMINAL_CONFLICT',
			eventResult: 'IGNORED',
		};
	}
	if (incoming === null) {
		return {
			status: current,
			needsReview: true,
			lastErrorCode: 'PROVIDER_UNSUPPORTED_STATE',
			eventResult: terminal ? 'IGNORED' : 'RETRY_PENDING',
		};
	}
	if (terminal && incoming === 'PENDING') {
		return {
			status: current,
			needsReview: payment.needsReview,
			lastErrorCode: payment.lastErrorCode,
			eventResult: 'IGNORED',
		};
	}
	return {
		status: incoming,
		needsReview: false,
		lastErrorCode: null,
		eventResult: terminalPayment(incoming) ? 'APPLIED' : 'RETRY_PENDING',
	};
}

@Injectable()
export class PaymentTransitionService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly provider: StripePaymentProvider,
	) {}

	validate(payment: Payment, snapshot: PaymentProviderSnapshot): void {
		this.provider.validateContext(snapshot);
		if (
			payment.provider !== WORKSPACE_PAYMENT_PRICE.provider ||
			snapshot.provider !== payment.provider
		)
			throw new PaymentProviderError('PROVIDER_MISMATCH');
		if (!isProviderId(snapshot.id)) throw new PaymentProviderError('PROVIDER_INVALID_ID');
		if (payment.providerPaymentId && payment.providerPaymentId !== snapshot.id) {
			throw new PaymentProviderError('PROVIDER_ID_MISMATCH');
		}
		if (snapshot.amountMinor !== payment.amountMinor || snapshot.currency !== payment.currency) {
			throw new PaymentProviderError('PROVIDER_AMOUNT_MISMATCH');
		}
		if (
			snapshot.clientReferenceId !== payment.id ||
			snapshot.metadata.paymentId !== payment.id ||
			snapshot.metadata.workspaceId !== payment.workspaceId
		) {
			throw new PaymentProviderError('PROVIDER_METADATA_MISMATCH');
		}
	}

	async apply(
		id: string,
		snapshot: PaymentProviderSnapshot,
		context: TransitionContext,
	): Promise<void> {
		await withSpan(
			'payment.transition',
			async (span) => {
				const status = await this.commitTransition(id, snapshot, context);
				span.setAttribute('payment.status', status);
				logEvent('info', 'payment.transition', { paymentId: id, result: status });
			},
			{ attributes: { 'payment.id': id, 'payment.reason': context.reason } },
		);
	}

	private async commitTransition(
		id: string,
		snapshot: PaymentProviderSnapshot,
		context: TransitionContext,
	) {
		if (context.event && context.event.providerObjectId !== snapshot.id) {
			throw new PaymentProviderError('PROVIDER_ID_MISMATCH');
		}

		for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
			try {
				return await this.prisma.$transaction((tx) =>
					this.applyInTransaction(tx, id, snapshot, context),
				);
			} catch (error: unknown) {
				if (error instanceof Prisma.PrismaClientKnownRequestError) {
					if (error.code === 'P2025' || error.code === 'P2034') continue;
					if (error.code === 'P2002') throw new PaymentProviderError('PROVIDER_ID_ALREADY_BOUND');
				}
				throw error;
			}
		}
		throw new PaymentProviderError('PAYMENT_CONCURRENT_UPDATE');
	}

	private async applyInTransaction(
		tx: Prisma.TransactionClient,
		id: string,
		snapshot: PaymentProviderSnapshot,
		{ event, leaseToken, reason, correlationId }: TransitionContext,
	) {
		const payment = await tx.payment.findUnique({ where: { id } });
		if (!payment) throw new PaymentProviderError('PAYMENT_NOT_FOUND');
		this.validate(payment, snapshot);
		if (event) await this.recordEvent(tx, event, { result: 'RETRY_PENDING' });

		const now = new Date();
		if (
			leaseToken !== undefined &&
			(payment.leaseToken !== leaseToken || !payment.leaseUntil || payment.leaseUntil <= now)
		) {
			throw new PaymentProviderError('PAYMENT_LEASE_LOST');
		}
		const { status, needsReview, lastErrorCode, eventResult } = planTransition(
			payment,
			snapshotStatus(snapshot.status),
		);
		await tx.payment.update({
			where: {
				id,
				status: payment.status,
				version: payment.version,
				...(leaseToken !== undefined ? { leaseToken, leaseUntil: { gt: now } } : {}),
			},
			data: {
				providerPaymentId: snapshot.id,
				confirmationUrl: terminalPayment(status) ? null : snapshot.confirmationUrl,
				status,
				needsReview,
				lastErrorCode,
				version: { increment: 1 },
			},
			select: { id: true },
		});
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
			await this.recordEvent(tx, event, {
				paymentId: id,
				result: eventResult,
				errorCode: lastErrorCode,
			});
		}
		return status;
	}

	async recordEvent(
		tx: Prisma.TransactionClient,
		event: PaymentEventKey,
		{ result, paymentId = null, errorCode = null }: EventOutcome,
	): Promise<void> {
		const now = new Date();
		const processedAt = result === 'APPLIED' || result === 'IGNORED' ? now : null;
		const nextReconcileAt = new Date(now.getTime() + 60_000);
		const eventLeaseToken = event.leaseToken ?? null;
		const [stored] = await tx.$queryRaw<Array<{ id: string }>>`
			INSERT INTO "PaymentEvent" (
				"id", "provider", "eventType", "providerObjectId", "paymentId", "result",
				"errorCode", "processedAt", "nextReconcileAt", "createdAt", "updatedAt"
			) SELECT
				${randomUUID()}::uuid, ${WORKSPACE_PAYMENT_PRICE.provider}, ${event.eventType}, ${event.providerObjectId},
				${paymentId}::uuid, ${result}, ${errorCode}, ${processedAt}, ${nextReconcileAt}, ${now}, ${now}
			WHERE ${eventLeaseToken}::uuid IS NULL OR EXISTS (
				SELECT 1 FROM "PaymentEvent" AS existing
				WHERE existing."provider" = ${WORKSPACE_PAYMENT_PRICE.provider}
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
			RETURNING "id"
		`;
		if (!stored && eventLeaseToken !== null) {
			throw new PaymentProviderError('PAYMENT_EVENT_LEASE_LOST');
		}
	}
}
