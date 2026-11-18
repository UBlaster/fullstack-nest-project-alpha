import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';

export interface StubSession {
	id: string;
	object: 'checkout.session';
	mode: 'payment';
	status: 'open' | 'complete' | 'expired';
	payment_status: 'unpaid' | 'paid' | 'no_payment_required';
	amount_total: number;
	currency: string;
	metadata: { paymentId: string; workspaceId: string };
	client_reference_id: string;
	url: string | null;
	livemode: boolean;
	payment_intent: string | null;
}

export interface StubCreateRequest {
	key: string;
	body: Record<string, unknown>;
	serializedBody: string;
}

interface HeldCreate {
	ready: (value: { payment: StubSession; request: StubCreateRequest }) => void;
	response: Promise<unknown>;
}

interface HeldGet {
	ready: (value: StubSession) => void;
	response: Promise<unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formBody(serialized: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of new URLSearchParams(serialized)) {
		const parts = key.match(/[^[\]]+/g);
		if (
			!parts?.length ||
			parts.some((part) => ['__proto__', 'constructor', 'prototype'].includes(part))
		)
			throw new Error('Invalid stub request field');
		let target: Record<string, unknown> | unknown[] = result;
		for (let index = 0; index < parts.length; index += 1) {
			const part = parts[index];
			const numeric = /^\d+$/.test(part);
			const read = () => (Array.isArray(target) ? target[Number(part)] : target[part]);
			const write = (next: unknown) => {
				if (Array.isArray(target)) target[Number(part)] = next;
				else target[part] = next;
			};
			if (Array.isArray(target) && !numeric) throw new Error('Invalid stub array field');
			if (index === parts.length - 1) {
				write(['quantity', 'unit_amount'].includes(part) ? Number(value) : value);
			} else {
				if (read() === undefined) write(/^\d+$/.test(parts[index + 1]) ? [] : {});
				const next = read();
				if (!record(next) && !Array.isArray(next)) throw new Error('Invalid stub nested field');
				target = next;
			}
		}
	}
	return result;
}

// Test-only HTTP protocol boundary; the real Stripe SDK performs auth, form serialization and retries.
export class StripeStub {
	readonly creates: StubCreateRequest[] = [];
	readonly gets: string[] = [];
	readonly payments = new Map<string, StubSession>();
	private readonly byKey = new Map<string, string>();
	private readonly bodiesByKey = new Map<string, string>();
	private readonly cachedFailures = new Map<string, number>();
	private server?: Server;
	private heldCreate?: HeldCreate;
	private heldGet?: HeldGet;
	private lostResponses = 0;
	private getFailure?: number;
	private createFailure?: number;
	private snapshotTransform?: (snapshot: StubSession) => unknown;
	baseUrl = '';

	constructor(readonly apiKey = 'sk_test_task8_key') {}

	async start(): Promise<void> {
		this.server = createServer((req, res) => {
			void this.handle(req, res).catch(() => this.failure(res, 500));
		});
		await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
		const address = this.server.address();
		if (!address || typeof address === 'string') throw new Error('Missing Stripe stub address');
		this.baseUrl = `http://127.0.0.1:${address.port}`;
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
		this.lostResponses = 0;
		this.getFailure = undefined;
		this.createFailure = undefined;
		this.snapshotTransform = undefined;
	}

	loseNextCreateResponse(): void {
		this.lostResponses = 2;
	}
	failNextGet(status = 503): void {
		this.getFailure = status;
	}
	failNextCreate(status: number): void {
		this.createFailure = status;
	}
	transformNextResponse(transform: (snapshot: StubSession) => unknown): void {
		this.snapshotTransform = transform;
	}

	holdNextCreate(): {
		ready: Promise<{ payment: StubSession; request: StubCreateRequest }>;
		release: (snapshot?: unknown) => void;
	} {
		if (this.heldCreate) throw new Error('A create response is already held');
		let notify: HeldCreate['ready'] = () => undefined;
		let release: (snapshot?: unknown) => void = () => undefined;
		const ready = new Promise<{ payment: StubSession; request: StubCreateRequest }>((resolve) => {
			notify = resolve;
		});
		const response = new Promise<unknown>((resolve) => {
			release = resolve;
		});
		this.heldCreate = { ready: notify, response };
		return { ready, release };
	}

	holdNextGet(): { ready: Promise<StubSession>; release: (snapshot?: unknown) => void } {
		if (this.heldGet) throw new Error('A GET response is already held');
		let notify: HeldGet['ready'] = () => undefined;
		let release: (snapshot?: unknown) => void = () => undefined;
		const ready = new Promise<StubSession>((resolve) => {
			notify = resolve;
		});
		const response = new Promise<unknown>((resolve) => {
			release = resolve;
		});
		this.heldGet = { ready: notify, response };
		return { ready, release };
	}

	change(id: string, changes: Partial<StubSession>): StubSession {
		const current = this.payments.get(id);
		if (!current) throw new Error('Unknown stub Checkout Session');
		const updated = { ...current, ...changes };
		this.payments.set(id, updated);
		return updated;
	}

	add(snapshot: StubSession): void {
		this.payments.set(snapshot.id, snapshot);
	}

	private send(res: ServerResponse, status: number, body: unknown): void {
		if (res.destroyed || res.writableEnded) return;
		res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_task8_stub' });
		res.end(JSON.stringify(body));
	}

	private failure(res: ServerResponse, status: number): void {
		this.send(res, status, {
			error: {
				type: status >= 500 ? 'api_error' : 'invalid_request_error',
				message: 'Controlled Stripe test response',
				code: status === 404 ? 'resource_missing' : 'test_failure',
			},
		});
	}

	private transform(snapshot: StubSession): unknown {
		const transform = this.snapshotTransform;
		this.snapshotTransform = undefined;
		return transform ? transform(snapshot) : snapshot;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.headers.authorization !== `Bearer ${this.apiKey}`) {
			this.failure(res, 401);
			return;
		}
		if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const serializedBody = Buffer.concat(chunks).toString('utf8');
			const body = formBody(serializedBody);
			const key = String(req.headers['idempotency-key'] ?? '');
			const create = { key, body, serializedBody };
			this.creates.push(create);
			const previousBody = this.bodiesByKey.get(key);
			if (previousBody && previousBody !== JSON.stringify(body)) {
				this.failure(res, 400);
				return;
			}
			if (this.createFailure) {
				const status = this.createFailure;
				this.createFailure = undefined;
				if (status >= 500) {
					this.cachedFailures.set(key, status);
					this.bodiesByKey.set(key, JSON.stringify(body));
				}
				this.failure(res, status);
				return;
			}
			const cachedFailure = this.cachedFailures.get(key);
			if (cachedFailure) {
				this.failure(res, cachedFailure);
				return;
			}
			const previousId = this.byKey.get(key);
			let session = previousId ? this.payments.get(previousId) : undefined;
			if (!session) {
				if (
					!record(body.metadata) ||
					typeof body.metadata.paymentId !== 'string' ||
					typeof body.metadata.workspaceId !== 'string' ||
					typeof body.client_reference_id !== 'string'
				)
					throw new Error('Invalid stub create request');
				const id = `cs_test_${randomUUID().replaceAll('-', '')}`;
				session = {
					id,
					object: 'checkout.session',
					mode: 'payment',
					status: 'open',
					payment_status: 'unpaid',
					amount_total: 1000,
					currency: 'usd',
					metadata: { paymentId: body.metadata.paymentId, workspaceId: body.metadata.workspaceId },
					client_reference_id: body.client_reference_id,
					url: `https://checkout.stripe.com/c/pay/${id}`,
					livemode: false,
					payment_intent: null,
				};
				this.payments.set(id, session);
				this.byKey.set(key, id);
				this.bodiesByKey.set(key, JSON.stringify(body));
			}
			if (this.lostResponses > 0) {
				this.lostResponses--;
				req.socket.destroy();
				return;
			}
			if (this.heldCreate) {
				const held = this.heldCreate;
				this.heldCreate = undefined;
				held.ready({ payment: session, request: create });
				const replacement = await held.response;
				this.send(res, 200, replacement ?? this.transform(session));
				return;
			}
			this.send(res, 200, this.transform(session));
			return;
		}
		if (req.method === 'GET' && req.url?.startsWith('/v1/checkout/sessions/')) {
			const id = decodeURIComponent(req.url.slice('/v1/checkout/sessions/'.length));
			this.gets.push(id);
			if (this.getFailure) {
				const status = this.getFailure;
				this.getFailure = undefined;
				this.failure(res, status);
				return;
			}
			const session = this.payments.get(id);
			if (!session) this.failure(res, 404);
			else if (this.heldGet) {
				const held = this.heldGet;
				this.heldGet = undefined;
				held.ready(session);
				const replacement = await held.response;
				this.send(res, 200, replacement ?? this.transform(session));
			} else this.send(res, 200, this.transform(session));
			return;
		}
		this.failure(res, 404);
	}
}
