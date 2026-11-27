import { createRequire } from 'node:module';
import {
	BadRequestException,
	Inject,
	Injectable,
	Logger,
	OnModuleInit,
	ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SpanKind } from '@opentelemetry/api';
import { Prisma } from '@prisma/client';
import type { Checkout, Stripe } from 'stripe';
import { traceHeaders } from '../observability/carrier';
import { meter, withSpan } from '../observability/telemetry';
import {
	isProviderId,
	PaymentProviderError,
	PaymentProviderSnapshot,
	WORKSPACE_PAYMENT_PRICE,
} from './payment-provider';

const StripeSdk: typeof import('stripe') = createRequire(__filename)('stripe');

export const STRIPE_API_BASE = Symbol('STRIPE_API_BASE');
export const STRIPE_PRODUCTION_API = 'https://api.stripe.com';

const STRIPE_API_VERSION = '2026-10-28.endive';
const STRIPE_CURRENCY = WORKSPACE_PAYMENT_PRICE.currency.toLowerCase();
const CHECKOUT_PRODUCT_NAME = 'Workspace demo payment';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TRANSPORT_ATTEMPTS = 2;
const TRANSPORT_RETRY_RESERVE_MS = 1000;
const externalDuration = meter.createHistogram('external.duration', { unit: 'ms' });
const externalErrors = meter.createCounter('external.errors');

export interface VerifiedStripeWebhook {
	eventId: string;
	eventType: 'checkout.session.completed' | 'checkout.session.expired';
	sessionId: string;
}

type PaymentMetadata = PaymentProviderSnapshot['metadata'];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPaymentMetadata(value: unknown): value is PaymentMetadata {
	return (
		isRecord(value) && typeof value.paymentId === 'string' && typeof value.workspaceId === 'string'
	);
}

function parseHttpUrl(value: unknown): URL | null {
	if (typeof value !== 'string') return null;
	try {
		const url = new URL(value);
		return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
			? url
			: null;
	} catch {
		return null;
	}
}

function checkoutRequest(
	{ paymentId, workspaceId }: PaymentMetadata,
	successUrl: string,
	cancelUrl: string,
	productName: string,
) {
	return {
		mode: 'payment',
		allowed_payment_method_types: ['card'],
		line_items: [
			{
				quantity: 1,
				price_data: {
					currency: STRIPE_CURRENCY,
					unit_amount: WORKSPACE_PAYMENT_PRICE.amountMinor,
					product_data: { name: productName },
				},
			},
		],
		success_url: successUrl,
		cancel_url: cancelUrl,
		client_reference_id: paymentId,
		metadata: { paymentId, workspaceId },
	} satisfies Checkout.SessionCreateParams;
}

function onlyEntry(value: unknown): unknown {
	return Array.isArray(value) && value.length === 1 ? value[0] : undefined;
}

function savedProductName(value: unknown): string | null {
	if (!isRecord(value) || value.quantity !== 1 || !isRecord(value.price_data)) return null;
	const { currency, unit_amount: amount, product_data: product } = value.price_data;
	if (currency !== STRIPE_CURRENCY || amount !== WORKSPACE_PAYMENT_PRICE.amountMinor) return null;
	return isRecord(product) && typeof product.name === 'string' ? product.name : null;
}

function savedCheckoutRequest(value: Prisma.JsonValue): Checkout.SessionCreateParams {
	if (!isRecord(value)) throw new PaymentProviderError('PROVIDER_INVALID_SAVED_REQUEST');

	const productName = savedProductName(onlyEntry(value.line_items));
	const { success_url: successUrl, cancel_url: cancelUrl, metadata } = value;
	if (
		value.mode !== 'payment' ||
		onlyEntry(value.allowed_payment_method_types) !== 'card' ||
		productName === null ||
		typeof successUrl !== 'string' ||
		!parseHttpUrl(successUrl) ||
		typeof cancelUrl !== 'string' ||
		!parseHttpUrl(cancelUrl) ||
		!isPaymentMetadata(metadata) ||
		value.client_reference_id !== metadata.paymentId
	) {
		throw new PaymentProviderError('PROVIDER_INVALID_SAVED_REQUEST');
	}

	return checkoutRequest(metadata, successUrl, cancelUrl, productName);
}

function checkoutStatus(
	status: unknown,
	paymentStatus: unknown,
): PaymentProviderSnapshot['status'] {
	if (status === 'complete' && paymentStatus === 'paid') return 'succeeded';
	if (paymentStatus === 'unpaid') {
		if (status === 'expired') return 'canceled';
		if (status === 'open' || status === 'complete') return 'pending';
	}
	throw new PaymentProviderError('PROVIDER_INVALID_RESPONSE');
}

function hostedCheckoutUrl(value: unknown): string {
	const url = parseHttpUrl(value);
	if (!url || url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.port)
		throw new PaymentProviderError('PROVIDER_INVALID_CONFIRMATION');
	return url.href;
}

function checkoutSnapshot(value: unknown): PaymentProviderSnapshot {
	if (!isRecord(value)) throw new PaymentProviderError('PROVIDER_INVALID_RESPONSE');

	const {
		id,
		livemode,
		amount_total: amountMinor,
		currency,
		metadata,
		client_reference_id: clientReferenceId,
	} = value;
	if (
		value.object !== 'checkout.session' ||
		value.mode !== 'payment' ||
		typeof id !== 'string' ||
		!isProviderId(id) ||
		typeof livemode !== 'boolean' ||
		typeof amountMinor !== 'number' ||
		!Number.isSafeInteger(amountMinor) ||
		amountMinor <= 0 ||
		typeof currency !== 'string' ||
		!/^[a-z]{3}$/.test(currency) ||
		!isPaymentMetadata(metadata) ||
		typeof clientReferenceId !== 'string'
	) {
		throw new PaymentProviderError('PROVIDER_INVALID_RESPONSE');
	}

	return {
		provider: WORKSPACE_PAYMENT_PRICE.provider,
		id,
		status: checkoutStatus(value.status, value.payment_status),
		test: !livemode,
		amountMinor,
		currency: currency.toUpperCase(),
		metadata: { paymentId: metadata.paymentId, workspaceId: metadata.workspaceId },
		clientReferenceId,
		confirmationUrl: value.status === 'open' ? hostedCheckoutUrl(value.url) : null,
	};
}

function invalidSignature(): BadRequestException {
	return new BadRequestException({
		code: 'PAYMENT_INVALID_SIGNATURE',
		message: 'Недействительное уведомление Stripe',
	});
}

function invalidWebhookEvent(): BadRequestException {
	return new BadRequestException({
		code: 'PAYMENT_INVALID_EVENT',
		message: 'Некорректное уведомление Stripe',
	});
}

function checkoutWebhook(event: unknown): VerifiedStripeWebhook | null {
	if (
		!isRecord(event) ||
		event.object !== 'event' ||
		typeof event.id !== 'string' ||
		!/^evt_[A-Za-z0-9_]{1,251}$/.test(event.id) ||
		typeof event.type !== 'string' ||
		typeof event.livemode !== 'boolean' ||
		!isRecord(event.data)
	)
		throw invalidWebhookEvent();

	if (event.livemode)
		throw new BadRequestException({
			code: 'PAYMENT_LIVE_EVENT_REJECTED',
			message: 'Допустимы только тестовые уведомления',
		});

	const eventType = event.type;
	if (eventType !== 'checkout.session.completed' && eventType !== 'checkout.session.expired')
		return null;

	const session = event.data.object;
	if (
		!isRecord(session) ||
		session.object !== 'checkout.session' ||
		typeof session.id !== 'string' ||
		!isProviderId(session.id)
	)
		throw invalidWebhookEvent();

	return { eventId: event.id, eventType, sessionId: session.id };
}

function providerError(error: unknown): PaymentProviderError {
	if (error instanceof PaymentProviderError) return error;
	if (error instanceof StripeSdk.errors.StripeError && typeof error.statusCode === 'number')
		return new PaymentProviderError(`PROVIDER_HTTP_${error.statusCode}`);
	return new PaymentProviderError('PROVIDER_UNAVAILABLE');
}

@Injectable()
export class StripePaymentProvider implements OnModuleInit {
	private cachedClient?: { apiKey: string; client: Stripe };

	constructor(
		private readonly config: ConfigService,
		@Inject(STRIPE_API_BASE) private readonly apiBase: string,
	) {}

	onModuleInit(): void {
		if (!this.isConfigured())
			new Logger(StripePaymentProvider.name).warn(
				'Test payments are not configured; document and export features remain available',
			);
	}

	isConfigured(): boolean {
		return this.testConfiguration() !== null;
	}

	assertConfigured(): void {
		this.requireConfiguration();
	}

	requestFor(paymentId: string, workspaceId: string): Prisma.InputJsonObject {
		const { returnBase } = this.requireConfiguration();
		const returnUrl = `${returnBase}/payments/${paymentId}/result`;
		return checkoutRequest({ paymentId, workspaceId }, returnUrl, returnUrl, CHECKOUT_PRODUCT_NAME);
	}

	validateContext(value: PaymentProviderSnapshot): void {
		if (value.provider !== WORKSPACE_PAYMENT_PRICE.provider || !value.test)
			throw new PaymentProviderError('PROVIDER_MODE_MISMATCH');
		if (value.clientReferenceId !== value.metadata.paymentId)
			throw new PaymentProviderError('PROVIDER_REFERENCE_MISMATCH');
	}

	create(body: Prisma.JsonValue, key: string): Promise<PaymentProviderSnapshot> {
		return this.readCheckout('create', (sessions, timeout, headers) =>
			sessions.create(savedCheckoutRequest(body), { idempotencyKey: key, timeout, headers }),
		);
	}

	get(id: string): Promise<PaymentProviderSnapshot> {
		return this.readCheckout(
			'retrieve',
			(sessions, timeout, headers) => sessions.retrieve(id, {}, { timeout, headers }),
			id,
		);
	}

	verifyWebhook(
		rawBody: Buffer | undefined,
		signature: string | string[] | undefined,
	): VerifiedStripeWebhook | null {
		const { webhookSecret } = this.requireConfiguration();
		if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string') throw invalidSignature();

		let event: unknown;
		try {
			event = StripeSdk.webhooks.constructEvent(rawBody, signature, webhookSecret);
		} catch {
			throw invalidSignature();
		}

		return checkoutWebhook(event);
	}

	httpTimeoutMs(): number {
		return MAX_TRANSPORT_ATTEMPTS * this.requestTimeoutMs() + TRANSPORT_RETRY_RESERVE_MS;
	}

	private async readCheckout(
		operation: 'create' | 'retrieve',
		request: (
			sessions: Checkout.SessionResource,
			timeout: number,
			headers: Record<string, string>,
		) => Promise<unknown>,
		expectedId?: string,
	): Promise<PaymentProviderSnapshot> {
		const { apiKey } = this.requireConfiguration();
		if (expectedId !== undefined && !isProviderId(expectedId))
			throw new PaymentProviderError('PROVIDER_INVALID_ID');

		const labels = { system: 'stripe', operation };
		return withSpan(
			`stripe.checkout.${operation}`,
			async () => {
				const started = performance.now();
				let result = 'error';
				try {
					const sessions = this.client(apiKey).checkout.sessions;
					const snapshot = checkoutSnapshot(
						await request(sessions, this.requestTimeoutMs(), traceHeaders()),
					);
					if (expectedId !== undefined && snapshot.id !== expectedId)
						throw new PaymentProviderError('PROVIDER_ID_MISMATCH');
					this.validateContext(snapshot);
					result = 'ok';
					return snapshot;
				} catch (error: unknown) {
					externalErrors.add(1, labels);
					throw providerError(error);
				} finally {
					externalDuration.record(performance.now() - started, { ...labels, result });
				}
			},
			{
				kind: SpanKind.CLIENT,
				attributes: {
					'http.request.method': operation === 'create' ? 'POST' : 'GET',
					'payment.provider': 'stripe',
				},
			},
		);
	}

	private testConfiguration() {
		const mode = this.config.get<string>('PAYMENT_MODE');
		const apiKey = this.config.get<string>('STRIPE_SECRET_KEY');
		const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
		const returnUrl = parseHttpUrl(this.config.get<string>('PAYMENT_RETURN_BASE_URL'));
		if (
			mode !== 'test' ||
			!apiKey ||
			!/^sk_test_[A-Za-z0-9_]+$/.test(apiKey) ||
			!webhookSecret ||
			!/^whsec_[A-Za-z0-9_]+$/.test(webhookSecret) ||
			!returnUrl ||
			returnUrl.search ||
			returnUrl.hash
		)
			return null;
		return { apiKey, webhookSecret, returnBase: returnUrl.href.replace(/\/$/, '') };
	}

	private requireConfiguration() {
		const settings = this.testConfiguration();
		if (!settings)
			throw new ServiceUnavailableException({
				code: 'PAYMENT_NOT_CONFIGURED',
				message: 'Тестовая интеграция Stripe не настроена',
			});
		return settings;
	}

	private requestTimeoutMs(): number {
		const timeout = Number(
			this.config.get<string>('PAYMENT_HTTP_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS,
		);
		return Number.isInteger(timeout) && timeout >= 100 && timeout <= 15_000
			? timeout
			: DEFAULT_TIMEOUT_MS;
	}

	private client(apiKey: string): Stripe {
		if (this.cachedClient?.apiKey === apiKey) return this.cachedClient.client;
		const api = parseHttpUrl(this.apiBase);
		if (
			!api ||
			api.search ||
			api.hash ||
			api.pathname !== '/' ||
			(api.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(api.hostname))
		)
			throw new PaymentProviderError('PROVIDER_INVALID_CONFIGURATION');

		const secure = api.protocol === 'https:';
		const client = new StripeSdk(apiKey, {
			apiVersion: STRIPE_API_VERSION,
			maxNetworkRetries: 0,
			host: api.hostname,
			port: Number(api.port || (secure ? 443 : 80)),
			protocol: secure ? 'https' : 'http',
			telemetry: false,
		});
		this.cachedClient = { apiKey, client };
		return client;
	}
}
