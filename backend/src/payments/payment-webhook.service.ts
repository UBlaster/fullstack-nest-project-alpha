import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { runWithRequestId } from '../diagnostics/request-context';
import { meter, withSpan } from '../observability/telemetry';
import { PrismaService } from '../prisma/prisma.service';
import {
	isInvalidPaymentSnapshot,
	paymentErrorCode,
	PaymentProviderError,
	WORKSPACE_PAYMENT_PRICE,
} from './payment-provider';
import { PaymentEventKey, PaymentTransitionService } from './payment-transition.service';
import { StripePaymentProvider } from './stripe-payment.provider';

const webhooks = meter.createCounter('payment.webhooks');

@Injectable()
export class PaymentWebhookService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly provider: StripePaymentProvider,
		private readonly transitions: PaymentTransitionService,
	) {}

	async handleStripeWebhook(
		rawBody: Buffer | undefined,
		signature: string | string[] | undefined,
	): Promise<void> {
		await withSpan('payment.webhook', async (span) => {
			let result = 'error';
			try {
				const event = this.provider.verifyWebhook(rawBody, signature);
				if (!event) {
					result = 'ignored';
					return;
				}
				try {
					result = await this.processEvent({
						eventType: event.eventType,
						providerObjectId: event.sessionId,
					});
				} catch {
					throw new ServiceUnavailableException({
						code: 'PAYMENT_VERIFICATION_UNAVAILABLE',
						message: 'Проверка платежа временно недоступна',
					});
				}
			} catch (error: unknown) {
				if (error instanceof HttpException && error.getStatus() < 500) result = 'rejected';
				throw error;
			} finally {
				span.setAttribute('payment.result', result);
				webhooks.add(1, { result });
			}
		});
	}

	async recoverEvent(event: PaymentEventKey): Promise<void> {
		await runWithRequestId(undefined, () =>
			withSpan('payment.webhook.reconcile', async (span) => {
				span.setAttribute('payment.result', await this.processEvent(event));
			}),
		);
	}

	private async processEvent(event: PaymentEventKey) {
		try {
			return await this.verifyAndApply(event);
		} catch (error: unknown) {
			const errorCode = paymentErrorCode(error);
			if (errorCode === 'PAYMENT_EVENT_LEASE_LOST') throw error;

			const ignored = isInvalidPaymentSnapshot(error);
			await this.transitions.recordEvent(this.prisma, event, {
				result: ignored ? 'IGNORED' : 'RETRY_PENDING',
				errorCode,
			});
			if (!ignored) throw error;
			return 'ignored';
		}
	}

	private async verifyAndApply(event: PaymentEventKey) {
		const snapshot = await this.provider.get(event.providerObjectId);
		const { paymentId } = snapshot.metadata;
		if (!isUUID(paymentId)) throw new PaymentProviderError('PROVIDER_METADATA_MISMATCH');

		const payment = await this.prisma.payment.findUnique({
			where: { id: paymentId },
			select: { id: true, provider: true },
		});
		if (payment) {
			if (payment.provider !== WORKSPACE_PAYMENT_PRICE.provider) {
				throw new PaymentProviderError('PROVIDER_MISMATCH');
			}
			await this.transitions.apply(payment.id, snapshot, {
				reason: 'VERIFIED_WEBHOOK',
				correlationId: `${event.eventType}:${event.providerObjectId}`,
				event,
			});
			return 'matched';
		}
		if (
			snapshot.amountMinor !== WORKSPACE_PAYMENT_PRICE.amountMinor ||
			snapshot.currency !== WORKSPACE_PAYMENT_PRICE.currency
		) {
			throw new PaymentProviderError('PROVIDER_AMOUNT_MISMATCH');
		}
		await this.transitions.recordEvent(this.prisma, event, { result: 'UNMATCHED' });
		return 'unmatched';
	}
}
