export const WORKSPACE_PAYMENT_PRICE = {
	provider: 'stripe',
	amountMinor: 1000,
	currency: 'USD',
} as const;

export interface PaymentProviderSnapshot {
	provider: 'stripe';
	id: string;
	status: 'pending' | 'succeeded' | 'canceled';
	test: boolean;
	amountMinor: number;
	currency: string;
	metadata: { paymentId: string; workspaceId: string };
	clientReferenceId: string;
	confirmationUrl: string | null;
}

export class PaymentProviderError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

export function paymentErrorCode(error: unknown): string {
	return error instanceof PaymentProviderError ? error.code : 'PAYMENT_STORAGE_UNAVAILABLE';
}

const invalidSnapshotCodes = new Set([
	'PROVIDER_MISMATCH',
	'PROVIDER_MODE_MISMATCH',
	'PROVIDER_REFERENCE_MISMATCH',
	'PROVIDER_ID_MISMATCH',
	'PROVIDER_AMOUNT_MISMATCH',
	'PROVIDER_METADATA_MISMATCH',
	'PROVIDER_INVALID_ID',
	'PROVIDER_INVALID_RESPONSE',
	'PROVIDER_INVALID_CONFIRMATION',
	'PROVIDER_HTTP_404',
	'PROVIDER_ID_ALREADY_BOUND',
]);

export function isInvalidPaymentSnapshot(error: unknown): boolean {
	return error instanceof PaymentProviderError && invalidSnapshotCodes.has(error.code);
}

export function isProviderId(value: string): boolean {
	return value.length <= 255 && /^cs_test_[A-Za-z0-9_]+$/.test(value);
}
