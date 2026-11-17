export interface PaymentAttempt {
	key: string;
	paymentId: string | null;
}

type AttemptStorage = Pick<Storage, 'getItem' | 'setItem'>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storageKey(userId: string, workspaceId: string): string {
	return `workspace-docs:payment-attempt:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`;
}

export function readPaymentAttempt(
	storage: AttemptStorage,
	userId: string,
	workspaceId: string,
): PaymentAttempt | null {
	const value = storage.getItem(storageKey(userId, workspaceId));
	if (value === null) return null;
	const parsed: unknown = JSON.parse(value);
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('key' in parsed) ||
		typeof parsed.key !== 'string' ||
		!uuid.test(parsed.key) ||
		!('paymentId' in parsed) ||
		(parsed.paymentId !== null &&
			(typeof parsed.paymentId !== 'string' || !uuid.test(parsed.paymentId)))
	) {
		throw new Error('Не удалось восстановить сохранённую попытку оплаты');
	}
	return { key: parsed.key, paymentId: parsed.paymentId };
}

export function savePaymentAttempt(
	storage: AttemptStorage,
	userId: string,
	workspaceId: string,
	attempt: PaymentAttempt,
): void {
	storage.setItem(storageKey(userId, workspaceId), JSON.stringify(attempt));
}
