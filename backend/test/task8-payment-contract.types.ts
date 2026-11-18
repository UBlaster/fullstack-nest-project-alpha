import type { Type } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import type { PaymentProviderMock } from './task8-payment-provider.mock';

type ContractPaymentStatus = 'CREATED' | 'PENDING' | 'SUCCEEDED' | 'CANCELLED' | 'FAILED';
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

interface ContractResponse {
	status: number;
	body: unknown;
}

interface ContractRequest {
	user?: ContractUser;
	key?: string;
	body?: unknown;
}

export type Notification = 'succeeded' | 'canceled';

export interface PaymentContractBinding {
	module: Type<unknown>;
	providerToken: string | symbol | Type<unknown>;
	mockProvider(mock: PaymentProviderMock): object;
	notify(app: TestingModule, externalId: string, event: Notification): Promise<void>;
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
	notify(paymentId: string, event: Notification): Promise<void>;
	records(paymentId: string): Promise<{ events: number; changes: number }>;
	close(): Promise<void>;
}
