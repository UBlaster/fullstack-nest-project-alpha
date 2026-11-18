import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

export interface MockPaymentRequest {
	paymentId: string;
	workspaceId: string;
	amountMinor: number;
	currency: string;
}

export interface MockPaymentSnapshot extends MockPaymentRequest {
	id: string;
	status: 'pending' | 'succeeded' | 'canceled';
	test: boolean;
	confirmationUrl: string | null;
}

export class MockProviderUnavailable extends Error {}

export class PaymentProviderMock {
	readonly creates: Array<{ key: string; body: unknown }> = [];
	readonly reads: string[] = [];
	loseNextCreateResponse = false;
	createDelayMs = 0;
	private readonly rows = new Map<string, MockPaymentSnapshot>();
	private readonly keys = new Map<string, { id: string; body: unknown }>();

	async create(
		request: MockPaymentRequest,
		key: string,
		body: unknown,
	): Promise<MockPaymentSnapshot> {
		const savedBody = structuredClone(body);
		this.creates.push({ key, body: savedBody });
		let previous = this.keys.get(key);
		if (previous && !isDeepStrictEqual(previous.body, savedBody)) {
			throw new Error('The provider key was reused with a different request body');
		}
		if (!previous) {
			previous = { id: randomUUID(), body: savedBody };
			this.keys.set(key, previous);
			this.rows.set(previous.id, {
				...request,
				id: previous.id,
				status: 'pending',
				test: true,
				confirmationUrl: 'https://checkout.example.test/payment',
			});
		}
		if (this.createDelayMs > 0) await setTimeout(this.createDelayMs);
		if (this.loseNextCreateResponse) {
			this.loseNextCreateResponse = false;
			throw new MockProviderUnavailable();
		}
		return this.snapshot(previous.id);
	}

	get(id: string): MockPaymentSnapshot {
		this.reads.push(id);
		return this.snapshot(id);
	}

	private snapshot(id: string): MockPaymentSnapshot {
		const row = this.rows.get(id);
		if (!row) throw new MockProviderUnavailable();
		return structuredClone(row);
	}

	forPayment(paymentId: string): MockPaymentSnapshot {
		const row = [...this.rows.values()].find((candidate) => candidate.paymentId === paymentId);
		if (!row) throw new Error('Mock payment was not created');
		return structuredClone(row);
	}

	setStatus(paymentId: string, status: MockPaymentSnapshot['status']): void {
		const row = this.forPayment(paymentId);
		this.rows.set(row.id, {
			...row,
			status,
			confirmationUrl: status === 'pending' ? row.confirmationUrl : null,
		});
	}
}
