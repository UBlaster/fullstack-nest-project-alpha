export type PaymentStatus = 'CREATED' | 'PENDING' | 'SUCCEEDED' | 'CANCELLED' | 'FAILED';
export type PaymentProvider = 'stripe' | 'yookassa';
export type PaymentCurrency = 'USD' | 'RUB';
export const PAYMENT_HISTORY_LIMIT = 20;

export interface PaymentCapabilities {
	enabled: boolean;
	provider: PaymentProvider;
	amountMinor: number;
	currency: PaymentCurrency;
}

export interface Payment {
	id: string;
	workspaceId: string;
	purpose: 'WORKSPACE_DEMO';
	provider: PaymentProvider;
	amountMinor: number;
	currency: PaymentCurrency;
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

export function parsePaymentCapabilities(value: unknown): PaymentCapabilities {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('enabled' in value) ||
		typeof value.enabled !== 'boolean' ||
		!('provider' in value) ||
		(value.provider !== 'stripe' && value.provider !== 'yookassa') ||
		!('amountMinor' in value) ||
		typeof value.amountMinor !== 'number' ||
		!Number.isSafeInteger(value.amountMinor) ||
		value.amountMinor <= 0 ||
		!('currency' in value) ||
		(value.currency !== 'USD' && value.currency !== 'RUB')
	) {
		throw new Error('Не удалось проверить параметры тестовой оплаты');
	}
	return {
		enabled: value.enabled,
		provider: value.provider,
		amountMinor: value.amountMinor,
		currency: value.currency,
	};
}

export function paymentProviderLabel(provider: PaymentProvider | null | undefined): string {
	if (provider === 'stripe') return 'Stripe';
	if (provider === 'yookassa') return 'ЮKassa';
	return 'платёжный сервис';
}

export function canUsePaymentProvider(
	payment: Pick<Payment, 'provider'>,
	capabilities: PaymentCapabilities | null | undefined,
): boolean {
	return capabilities?.enabled === true && payment.provider === capabilities.provider;
}

export function canStartAnotherPayment(
	payment: Payment,
	capabilities: PaymentCapabilities | null,
): boolean {
	return (
		(capabilities !== null && payment.provider !== capabilities.provider) ||
		(isTerminalPayment(payment) && !payment.needsReview)
	);
}

export function confirmationLink(
	payment: Payment,
	capabilities: PaymentCapabilities | null | undefined,
): string | null {
	if (!canUsePaymentProvider(payment, capabilities)) return null;
	if (payment.needsReview || payment.status !== 'PENDING' || !payment.confirmationUrl) return null;
	try {
		const url = new URL(payment.confirmationUrl);
		if (url.protocol !== 'https:' || url.username || url.password) return null;
		if (payment.provider === 'stripe' && url.origin !== 'https://checkout.stripe.com') return null;
		return url.href;
	} catch {
		return null;
	}
}

export function paymentAmount(payment: Pick<Payment, 'amountMinor' | 'currency'>): string {
	return new Intl.NumberFormat(payment.currency === 'USD' ? 'en-US' : 'ru-RU', {
		style: 'currency',
		currency: payment.currency,
		minimumFractionDigits: payment.amountMinor % 100 === 0 ? 0 : 2,
		maximumFractionDigits: 2,
	}).format(payment.amountMinor / 100);
}
