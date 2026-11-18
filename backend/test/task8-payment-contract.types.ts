import type { PaymentProviderMock } from './task8-payment-provider.mock';

export type ContractPaymentStatus = 'CREATED' | 'PENDING' | 'SUCCEEDED' | 'CANCELLED' | 'FAILED';
export type ContractUser = 'owner' | 'member' | 'viewer' | 'outsider' | 'anonymous';

export interface ContractPayment {
	id: string;
	workspaceId: string;
	purpose: string;
	amountMinor: number;
	currency: string;
	status: ContractPaymentStatus;
	confirmationUrl: string | null;
	needsReview: boolean;
	lastErrorCode: string | null;
}

export interface ContractResponse {
	status: number;
	body: unknown;
}

export interface ContractRequest {
	user?: ContractUser;
	key?: string;
	body?: unknown;
}

export interface PaymentContractHarness {
	workspaceId: string;
	otherWorkspaceId: string;
	provider: PaymentProviderMock;
	request(
		method: 'GET' | 'POST',
		path: string,
		options?: ContractRequest,
	): Promise<ContractResponse>;
	notify(paymentId: string): Promise<void>;
	auditCount(paymentId: string): Promise<number>;
	events(paymentId: string): Promise<{
		next(): Promise<ContractPayment>;
		close(): Promise<void>;
	}>;
	close(): Promise<void>;
}
