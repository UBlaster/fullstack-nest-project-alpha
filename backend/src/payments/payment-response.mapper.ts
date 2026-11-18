import { WORKSPACE_PAYMENT_PRICE } from './payment-provider';
import { PaymentResponseRow } from './payment-response.select';
import { terminalPayment } from './payment-transition.service';

export function toPaymentResponse(payment: PaymentResponseRow) {
	return {
		...payment,
		confirmationUrl:
			payment.provider !== WORKSPACE_PAYMENT_PRICE.provider ||
			terminalPayment(payment.status) ||
			payment.needsReview
				? null
				: payment.confirmationUrl,
	};
}
