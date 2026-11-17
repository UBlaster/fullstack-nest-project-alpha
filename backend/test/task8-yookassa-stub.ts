import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';

export interface StubPayment {
	id: string;
	status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
	amount: { value: string; currency: string };
	recipient: { account_id: string; gateway_id: string };
	metadata: { paymentId: string; workspaceId: string };
	confirmation?: { type: 'redirect'; confirmation_url: string };
	test: boolean;
	paid: boolean;
	created_at: string;
}

export interface StubCreateRequest {
	key: string;
	body: Record<string, unknown>;
	serializedBody: string;
}

interface HeldCreate {
	ready: (value: { payment: StubPayment; request: StubCreateRequest }) => void;
	response: Promise<unknown>;
}

interface HeldGet {
	ready: (value: StubPayment) => void;
	response: Promise<unknown>;
}

// A test-only HTTP boundary: it commits the external operation before allowing a response fault.
export class YooKassaStub {
	readonly creates: StubCreateRequest[] = [];
	readonly gets: string[] = [];
	readonly payments = new Map<string, StubPayment>();
	private readonly byKey = new Map<string, string>();
	private server: Server | undefined;
	private heldCreate: HeldCreate | undefined;
	private heldGet: HeldGet | undefined;
	private loseCreate = false;
	private getFailure: number | undefined;
	private createFailure: number | undefined;
	private snapshotTransform: ((snapshot: StubPayment) => unknown) | undefined;
	baseUrl = '';

	constructor(readonly shopId = '123456789') {}

	async start(): Promise<void> {
		this.server = createServer((req, res) => {
			void this.handle(req, res).catch(() => this.send(res, 500, { code: 'stub_error' }));
		});
		await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
		const address = this.server.address();
		if (!address || typeof address === 'string') throw new Error('Missing stub TCP address');
		this.baseUrl = `http://127.0.0.1:${address.port}/v3`;
	}

	async close(): Promise<void> {
		if (!this.server) return;
		const server = this.server;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
			server.closeAllConnections();
		});
		this.server = undefined;
	}

	resetFaults(): void {
		this.loseCreate = false;
		this.getFailure = undefined;
		this.createFailure = undefined;
		this.snapshotTransform = undefined;
	}

	loseNextCreateResponse(): void {
		this.loseCreate = true;
	}

	failNextGet(status = 503): void {
		this.getFailure = status;
	}

	failNextCreate(status: number): void {
		this.createFailure = status;
	}

	transformNextResponse(transform: (snapshot: StubPayment) => unknown): void {
		this.snapshotTransform = transform;
	}

	holdNextCreate(): {
		ready: Promise<{ payment: StubPayment; request: StubCreateRequest }>;
		release: (snapshot?: unknown) => void;
	} {
		if (this.heldCreate) throw new Error('A create response is already held');
		let notify: HeldCreate['ready'] = () => undefined;
		let release: (snapshot?: unknown) => void = () => undefined;
		const ready = new Promise<{ payment: StubPayment; request: StubCreateRequest }>((resolve) => {
			notify = resolve;
		});
		const response = new Promise<unknown>((resolve) => {
			release = resolve;
		});
		this.heldCreate = { ready: notify, response };
		return { ready, release };
	}

	holdNextGet(): { ready: Promise<StubPayment>; release: (snapshot?: unknown) => void } {
		if (this.heldGet) throw new Error('A GET response is already held');
		let notify: HeldGet['ready'] = () => undefined;
		let release: (snapshot?: unknown) => void = () => undefined;
		const ready = new Promise<StubPayment>((resolve) => {
			notify = resolve;
		});
		const response = new Promise<unknown>((resolve) => {
			release = resolve;
		});
		this.heldGet = { ready: notify, response };
		return { ready, release };
	}

	change(id: string, changes: Partial<StubPayment>): StubPayment {
		const current = this.payments.get(id);
		if (!current) throw new Error('Unknown stub payment');
		const updated = { ...current, ...changes };
		this.payments.set(id, updated);
		return updated;
	}

	add(snapshot: StubPayment): void {
		this.payments.set(snapshot.id, snapshot);
	}

	private send(res: ServerResponse, status: number, body: unknown): void {
		if (res.destroyed || res.writableEnded) return;
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify(body));
	}

	private transform(snapshot: StubPayment): unknown {
		const transform = this.snapshotTransform;
		this.snapshotTransform = undefined;
		return transform ? transform(snapshot) : snapshot;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (
			req.headers.authorization !==
			`Basic ${Buffer.from(`${this.shopId}:test_task8_key`).toString('base64')}`
		) {
			this.send(res, 401, { type: 'error', code: 'invalid_credentials' });
			return;
		}
		if (req.method === 'POST' && req.url === '/v3/payments') {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const serializedBody = Buffer.concat(chunks).toString('utf8');
			const body = JSON.parse(serializedBody) as Record<string, unknown>;
			const key = String(req.headers['idempotence-key'] ?? '');
			const create = { key, body, serializedBody };
			this.creates.push(create);
			if (this.createFailure) {
				const status = this.createFailure;
				this.createFailure = undefined;
				this.send(res, status, {
					type: 'error',
					code: status === 400 ? 'invalid_request' : 'internal_server_error',
				});
				return;
			}
			const previousId = this.byKey.get(key);
			let snapshot = previousId ? this.payments.get(previousId) : undefined;
			if (!snapshot) {
				snapshot = {
					id: randomUUID(),
					status: 'pending',
					amount: body.amount as StubPayment['amount'],
					recipient: { account_id: this.shopId, gateway_id: 'task8-test-gateway' },
					metadata: body.metadata as StubPayment['metadata'],
					confirmation: {
						type: 'redirect',
						confirmation_url: `https://yoomoney.ru/checkout/payments/v2/contract?orderId=${randomUUID()}`,
					},
					test: true,
					paid: false,
					created_at: new Date().toISOString(),
				};
				this.payments.set(snapshot.id, snapshot);
				this.byKey.set(key, snapshot.id);
			}
			if (this.loseCreate) {
				this.loseCreate = false;
				req.socket.destroy();
				return;
			}
			if (this.heldCreate) {
				const held = this.heldCreate;
				this.heldCreate = undefined;
				held.ready({ payment: snapshot, request: create });
				const replacement = await held.response;
				this.send(res, 200, replacement ?? this.transform(snapshot));
				return;
			}
			this.send(res, 200, this.transform(snapshot));
			return;
		}
		if (req.method === 'GET' && req.url?.startsWith('/v3/payments/')) {
			const id = decodeURIComponent(req.url.slice('/v3/payments/'.length));
			this.gets.push(id);
			if (this.getFailure) {
				const status = this.getFailure;
				this.getFailure = undefined;
				this.send(res, status, { type: 'error', code: 'internal_server_error' });
				return;
			}
			const snapshot = this.payments.get(id);
			if (!snapshot) this.send(res, 404, { type: 'error', code: 'not_found' });
			else if (this.heldGet) {
				const held = this.heldGet;
				this.heldGet = undefined;
				held.ready(snapshot);
				const replacement = await held.response;
				this.send(res, 200, replacement ?? this.transform(snapshot));
			} else this.send(res, 200, this.transform(snapshot));
			return;
		}
		this.send(res, 404, { code: 'not_found' });
	}
}
