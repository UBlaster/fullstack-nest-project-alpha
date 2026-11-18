import { randomUUID } from 'node:crypto';

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
	readonly creates: Array<{ key: string; request: MockPaymentRequest }> = [];
	readonly reads: string[] = [];
	loseNextCreateResponse = false;
	private readonly rows = new Map<string, MockPaymentSnapshot>();
	private readonly keys = new Map<string, string>();
	private held?: { ready: () => void; released: Promise<void> };

	holdNextCreate() {
		let ready: () => void = () => {};
		let release: () => void = () => {};
		const started = new Promise<void>((resolve) => (ready = resolve));
		const released = new Promise<void>((resolve) => (release = resolve));
		this.held = { ready, released };
		return { started, release };
	}

	async create(request: MockPaymentRequest, key: string): Promise<MockPaymentSnapshot> {
		this.creates.push({ key, request: structuredClone(request) });
		let id = this.keys.get(key);
		if (!id) {
			id = randomUUID();
			this.keys.set(key, id);
			this.rows.set(id, {
				...request,
				id,
				status: 'pending',
				test: true,
				confirmationUrl: 'https://checkout.example.test/payment',
			});
		}
		if (this.held) {
			const held = this.held;
			this.held = undefined;
			held.ready();
			await held.released;
		}
		if (this.loseNextCreateResponse) {
			this.loseNextCreateResponse = false;
			throw new MockProviderUnavailable();
		}
		return this.get(id);
	}

	get(id: string): MockPaymentSnapshot {
		this.reads.push(id);
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
