import {
	Inject,
	Injectable,
	Logger,
	OnModuleInit,
	ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

// Tests override this DI token; runtime configuration cannot redirect authenticated requests.
export const YOOKASSA_API_BASE = Symbol('YOOKASSA_API_BASE');
export const YOOKASSA_PRODUCTION_API = 'https://api.yookassa.ru/v3';

export interface YooKassaSnapshot {
	id: string;
	status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
	test: boolean;
	amount: { value: string; currency: string };
	recipient: { account_id: string };
	metadata: { paymentId: string; workspaceId: string };
	confirmation?: { type: 'redirect'; confirmation_url: string };
}

export class PaymentProviderError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

export function isProviderId(value: string): boolean {
	return /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snapshot(value: unknown): YooKassaSnapshot {
	if (
		!record(value) ||
		typeof value.id !== 'string' ||
		!isProviderId(value.id) ||
		!['pending', 'waiting_for_capture', 'succeeded', 'canceled'].includes(String(value.status)) ||
		typeof value.test !== 'boolean' ||
		!record(value.amount) ||
		typeof value.amount.value !== 'string' ||
		!/^\d{1,9}\.\d{2}$/.test(value.amount.value) ||
		typeof value.amount.currency !== 'string' ||
		!record(value.recipient) ||
		typeof value.recipient.account_id !== 'string' ||
		!record(value.metadata) ||
		typeof value.metadata.paymentId !== 'string' ||
		typeof value.metadata.workspaceId !== 'string'
	)
		throw new PaymentProviderError('PROVIDER_INVALID_RESPONSE');
	let confirmation: YooKassaSnapshot['confirmation'];
	if (value.confirmation !== undefined) {
		if (
			!record(value.confirmation) ||
			value.confirmation.type !== 'redirect' ||
			typeof value.confirmation.confirmation_url !== 'string'
		) {
			throw new PaymentProviderError('PROVIDER_INVALID_CONFIRMATION');
		}
		const url = new URL(value.confirmation.confirmation_url);
		if (url.protocol !== 'https:' || url.username || url.password)
			throw new PaymentProviderError('PROVIDER_INVALID_CONFIRMATION');
		confirmation = { type: 'redirect', confirmation_url: url.href };
	}
	return {
		id: value.id,
		status: value.status as YooKassaSnapshot['status'],
		test: value.test,
		amount: { value: value.amount.value, currency: value.amount.currency },
		recipient: { account_id: value.recipient.account_id },
		metadata: { paymentId: value.metadata.paymentId, workspaceId: value.metadata.workspaceId },
		...(confirmation ? { confirmation } : {}),
	};
}

@Injectable()
export class YooKassaPaymentProvider implements OnModuleInit {
	constructor(
		private readonly config: ConfigService,
		@Inject(YOOKASSA_API_BASE) private readonly baseUrl: string,
	) {}

	onModuleInit(): void {
		if (!this.isConfigured())
			new Logger(YooKassaPaymentProvider.name).warn(
				'Test payments are not configured; document and export features remain available',
			);
	}

	isConfigured(): boolean {
		return (
			this.config.get<string>('PAYMENT_MODE') === 'test' &&
			/^\d+$/.test(this.config.get<string>('YOOKASSA_SHOP_ID') ?? '') &&
			(this.config.get<string>('YOOKASSA_SECRET_KEY') ?? '').startsWith('test_') &&
			this.returnBaseUrl() !== null
		);
	}

	assertConfigured(): void {
		if (!this.isConfigured())
			throw new ServiceUnavailableException({
				code: 'PAYMENT_NOT_CONFIGURED',
				message: 'Тестовая интеграция ЮKassa не настроена',
			});
	}

	requestFor(paymentId: string, workspaceId: string): Prisma.InputJsonObject {
		this.assertConfigured();
		return {
			amount: { value: '100.00', currency: 'RUB' },
			capture: true,
			confirmation: {
				type: 'redirect',
				return_url: `${this.returnBaseUrl()}/payments/${paymentId}/result`,
			},
			description: 'Тестовая оплата workspace',
			metadata: { paymentId, workspaceId },
		};
	}

	validateShop(value: YooKassaSnapshot): void {
		if (!value.test || value.recipient.account_id !== this.config.get<string>('YOOKASSA_SHOP_ID'))
			throw new PaymentProviderError('PROVIDER_SHOP_OR_MODE_MISMATCH');
	}

	async create(body: Prisma.JsonValue, key: string): Promise<YooKassaSnapshot> {
		return this.request('/payments', { method: 'POST', body: JSON.stringify(body) }, key);
	}

	async get(id: string): Promise<YooKassaSnapshot> {
		if (!isProviderId(id)) throw new PaymentProviderError('PROVIDER_INVALID_ID');
		const result = await this.request(`/payments/${encodeURIComponent(id)}`, { method: 'GET' });
		if (result.id !== id) throw new PaymentProviderError('PROVIDER_ID_MISMATCH');
		return result;
	}

	httpTimeoutMs(): number {
		const value = Number(this.config.get<string>('PAYMENT_HTTP_TIMEOUT_MS') ?? 10_000);
		return Number.isInteger(value) && value >= 100 && value <= 15_000 ? value : 10_000;
	}

	private returnBaseUrl(): string | null {
		try {
			const url = new URL(this.config.get<string>('PAYMENT_RETURN_BASE_URL') ?? '');
			if (
				!['http:', 'https:'].includes(url.protocol) ||
				url.username ||
				url.password ||
				url.search ||
				url.hash
			)
				return null;
			return url.href.replace(/\/$/, '');
		} catch {
			return null;
		}
	}

	private async request(path: string, init: RequestInit, key?: string): Promise<YooKassaSnapshot> {
		this.assertConfigured();
		const shopId = this.config.get<string>('YOOKASSA_SHOP_ID');
		const secret = this.config.get<string>('YOOKASSA_SECRET_KEY');
		try {
			const response = await fetch(`${this.baseUrl}${path}`, {
				...init,
				redirect: 'error',
				signal: AbortSignal.timeout(this.httpTimeoutMs()),
				headers: {
					Authorization: `Basic ${Buffer.from(`${shopId}:${secret}`).toString('base64')}`,
					'Content-Type': 'application/json',
					...(key ? { 'Idempotence-Key': key } : {}),
				},
			});
			// A rejection after an unknown POST outcome cannot prove absence of an operation.
			if (!response.ok) throw new PaymentProviderError(`PROVIDER_HTTP_${response.status}`);
			const result = snapshot((await response.json()) as unknown);
			this.validateShop(result);
			return result;
		} catch (error: unknown) {
			if (error instanceof PaymentProviderError) throw error;
			throw new PaymentProviderError('PROVIDER_UNAVAILABLE');
		}
	}
}
