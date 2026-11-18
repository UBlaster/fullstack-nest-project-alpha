import { PaymentProviderError, WORKSPACE_PAYMENT_PRICE } from '../src/payments/payment-provider';
import { PaymentWebhookService } from '../src/payments/payment-webhook.service';
import { PaymentsModule } from '../src/payments/payments.module';
import { StripePaymentProvider } from '../src/payments/stripe-payment.provider';
import type { PaymentContractBinding } from './task8-payment-contract.types';
import { MockProviderUnavailable, type MockPaymentSnapshot } from './task8-payment-provider.mock';

const externalId = (id: string) => `cs_test_${id.replaceAll('-', '_')}`;

function snapshot(row: MockPaymentSnapshot) {
	return {
		provider: WORKSPACE_PAYMENT_PRICE.provider,
		id: externalId(row.id),
		status: row.status,
		test: row.test,
		amountMinor: row.amountMinor,
		currency: row.currency,
		metadata: { paymentId: row.paymentId, workspaceId: row.workspaceId },
		clientReferenceId: row.paymentId,
		confirmationUrl: row.confirmationUrl,
	};
}

export function paymentContractBinding(): PaymentContractBinding {
	return {
		module: PaymentsModule,
		providerToken: StripePaymentProvider,
		mockProvider(mock) {
			return {
				isConfigured: () => true,
				assertConfigured: () => {},
				validateContext: () => {},
				httpTimeoutMs: () => 1_000,
				requestFor: (paymentId: string, workspaceId: string) => ({
					...WORKSPACE_PAYMENT_PRICE,
					paymentId,
					workspaceId,
				}),
				async create(body: Parameters<typeof mock.create>[0], key: string) {
					try {
						return snapshot(await mock.create(body, key, body));
					} catch (error) {
						if (!(error instanceof MockProviderUnavailable)) throw error;
						throw new PaymentProviderError('PROVIDER_UNAVAILABLE');
					}
				},
				get: async (id: string) =>
					snapshot(mock.get(id.slice('cs_test_'.length).replaceAll('_', '-'))),
			};
		},
		notify(app, id, event) {
			return app.get(PaymentWebhookService).recoverEvent({
				eventType:
					event === 'succeeded' ? 'checkout.session.completed' : 'checkout.session.expired',
				providerObjectId: externalId(id),
			});
		},
	};
}
