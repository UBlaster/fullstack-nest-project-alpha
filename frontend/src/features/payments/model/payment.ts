export type PaymentStatus = 'CREATED' | 'PENDING' | 'SUCCEEDED' | 'CANCELLED' | 'FAILED';

export interface Payment {
	id: string;
	workspaceId: string;
	purpose: 'WORKSPACE_DEMO';
	amountMinor: number;
	currency: 'RUB';
	status: PaymentStatus;
	confirmationUrl: string | null;
	needsReview: boolean;
	lastErrorCode: string | null;
	createdAt: string;
	updatedAt: string;
}

export function isTerminalPayment(payment: Pick<Payment, 'status'>): boolean {
	return ['SUCCEEDED', 'CANCELLED', 'FAILED'].includes(payment.status);
}

export function canReconcilePayment(payment: Pick<Payment, 'status' | 'needsReview'>): boolean {
	return !isTerminalPayment(payment) || payment.needsReview;
}

export function mergePaymentSnapshot(previous: Payment | null, next: Payment): Payment {
	if (!previous || previous.id !== next.id) return next;
	if (isTerminalPayment(previous) && previous.status !== next.status) return previous;
	return previous.updatedAt > next.updatedAt ? previous : next;
}

export function paymentStatusLabel(payment: Pick<Payment, 'status' | 'needsReview'>): string {
	if (payment.needsReview) return 'Нужна ручная сверка';
	return {
		CREATED: 'Уточняем создание платежа',
		PENDING: 'Ожидает оплаты',
		SUCCEEDED: 'Оплачено',
		CANCELLED: 'Отменено',
		FAILED: 'Платёж не создан',
	}[payment.status];
}

export function confirmationLink(payment: Payment): string | null {
	if (payment.needsReview || payment.status !== 'PENDING' || !payment.confirmationUrl) return null;
	try {
		const url = new URL(payment.confirmationUrl);
		return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

export function paymentAmount(payment: Pick<Payment, 'amountMinor' | 'currency'>): string {
	return `${Math.floor(payment.amountMinor / 100)},${String(payment.amountMinor % 100).padStart(2, '0')} ₽`;
}
