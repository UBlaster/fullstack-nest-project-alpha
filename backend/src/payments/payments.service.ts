import { createHash, randomUUID } from 'node:crypto';
import {
	ConflictException,
	HttpException,
	Injectable,
	MessageEvent,
	NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Observable } from 'rxjs';
import { AccessPolicyService } from '../access/access-policy.service';
import { logEvent } from '../observability/logger';
import { withSpan } from '../observability/telemetry';
import { PrismaService } from '../prisma/prisma.service';
import { WORKSPACE_PAYMENT_PRICE } from './payment-provider';
import { PaymentRecoveryService } from './payment-recovery.service';
import { toPaymentResponse } from './payment-response.mapper';
import { paymentResponseSelect, PaymentResponseRow } from './payment-response.select';
import { terminalPayment } from './payment-transition.service';
import { StripePaymentProvider } from './stripe-payment.provider';

export const PAYMENT_EVENTS_INTERVAL_MS = 2_000;
export const PAYMENT_EVENTS_DURATION_MS = 300_000;

const paymentLookupSelect = {
	...paymentResponseSelect,
	requestHash: true,
	firstDispatchedAt: true,
	providerPaymentId: true,
} satisfies Prisma.PaymentSelect;

@Injectable()
export class PaymentsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly access: AccessPolicyService,
		private readonly provider: StripePaymentProvider,
		private readonly recovery: PaymentRecoveryService,
	) {}

	async capabilities(userId: string, workspaceId: string) {
		await this.access.requireWorkspace(userId, workspaceId, 'view', 'payment');
		return { enabled: this.provider.isConfigured(), ...WORKSPACE_PAYMENT_PRICE };
	}

	async create(userId: string, workspaceId: string, purpose: 'WORKSPACE_DEMO', key: string) {
		await this.access.requireWorkspace(userId, workspaceId, 'create', 'payment');
		this.provider.assertConfigured();
		const idempotencyKey = key.toLowerCase();
		const purchase = { workspaceId, purpose, ...WORKSPACE_PAYMENT_PRICE };
		const requestHash = createHash('sha256').update(JSON.stringify(purchase)).digest('hex');
		const { payment, created } = await withSpan('payment.reserve', async (span) => {
			const result = await this.reservePayment({ userId, idempotencyKey }, purchase, requestHash);
			span.setAttribute('payment.id', result.payment.id);
			return result;
		});
		const { requestHash: savedRequestHash, firstDispatchedAt, ...reserved } = payment;
		if (savedRequestHash !== requestHash)
			throw new ConflictException({
				code: 'PAYMENT_KEY_CONFLICT',
				message: 'Ключ уже использован для другой покупки',
			});
		let current = reserved;
		if (created || (!firstDispatchedAt && !reserved.providerPaymentId)) {
			await this.recovery.recover(reserved.id, undefined, 'create');
			current = await this.prisma.payment.findUniqueOrThrow({
				where: { id: reserved.id },
				select: { ...paymentResponseSelect, providerPaymentId: true },
			});
		}
		const { providerPaymentId, ...response } = current;
		const known = providerPaymentId !== null || terminalPayment(response.status);
		return {
			payment: toPaymentResponse(response),
			statusCode: known ? (created ? 201 : 200) : 202,
		};
	}

	async get(userId: string, id: string) {
		return toPaymentResponse(await this.requirePayment(userId, id));
	}

	async events(userId: string, id: string): Promise<Observable<MessageEvent>> {
		const snapshot = () =>
			withSpan('payment.sse.snapshot', async (span) => {
				const payment = await this.get(userId, id);
				span.setAttributes({ 'payment.id': id, 'payment.status': payment.status });
				return payment;
			});
		const initial = await snapshot();
		return new Observable((subscriber) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let previous: string | undefined;
			const deadline = setTimeout(() => subscriber.complete(), PAYMENT_EVENTS_DURATION_MS);
			const emit = (payment: typeof initial) => {
				if (subscriber.closed) return;
				const content = JSON.stringify({ ...payment, updatedAt: undefined });
				if (content !== previous) {
					previous = content;
					logEvent('info', 'payment.sse.emit', { paymentId: id, result: payment.status });
					subscriber.next({ type: 'payment', data: payment });
				}
				if (terminalPayment(payment.status) || payment.needsReview) subscriber.complete();
				else if (!subscriber.closed)
					timer = setTimeout(() => void read(), PAYMENT_EVENTS_INTERVAL_MS);
			};
			const read = async () => {
				try {
					emit(await snapshot());
				} catch (error: unknown) {
					if (subscriber.closed) return;
					subscriber.next({
						type: 'payment-error',
						data: { statusCode: error instanceof HttpException ? error.getStatus() : 503 },
					});
					subscriber.complete();
				}
			};
			emit(initial);
			return () => {
				clearTimeout(timer);
				clearTimeout(deadline);
			};
		});
	}

	async history(userId: string, workspaceId: string, limit: number) {
		await this.access.requireWorkspace(userId, workspaceId, 'view', 'payment');
		const payments = await this.prisma.payment.findMany({
			where: { workspaceId },
			select: paymentResponseSelect,
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			take: limit,
		});
		return payments.map(toPaymentResponse);
	}

	async reconcile(userId: string, id: string) {
		const payment = await this.requirePayment(userId, id);
		if (payment.provider !== WORKSPACE_PAYMENT_PRICE.provider) {
			throw new ConflictException({
				code: 'PAYMENT_PROVIDER_UNSUPPORTED',
				message: 'Платёж прежнего провайдера доступен только для просмотра',
			});
		}
		await this.recovery.recover(id);
		return toPaymentResponse(
			await this.prisma.payment.findUniqueOrThrow({
				where: { id },
				select: paymentResponseSelect,
			}),
		);
	}

	private async reservePayment(
		identity: { userId: string; idempotencyKey: string },
		purchase: Pick<Prisma.PaymentUncheckedCreateInput, 'workspaceId' | 'purpose'> &
			typeof WORKSPACE_PAYMENT_PRICE,
		requestHash: string,
	) {
		const lookup = {
			where: { userId_idempotencyKey: identity },
			select: paymentLookupSelect,
		};
		const existing = await this.prisma.payment.findUnique(lookup);
		if (existing) return { payment: existing, created: false };

		const id = randomUUID();
		try {
			const payment = await this.prisma.payment.create({
				data: {
					id,
					...purchase,
					...identity,
					requestHash,
					providerIdempotenceKey: randomUUID(),
					providerRequest: this.provider.requestFor(id, purchase.workspaceId),
				},
				select: paymentLookupSelect,
			});
			return { payment, created: true };
		} catch (error: unknown) {
			if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
				throw error;
			}
			const payment = await this.prisma.payment.findUniqueOrThrow(lookup);
			return { payment, created: false };
		}
	}

	private async requirePayment(userId: string, id: string): Promise<PaymentResponseRow> {
		const payment = await this.prisma.payment.findUnique({
			where: { id },
			select: paymentResponseSelect,
		});
		if (!payment) throw new NotFoundException();
		await this.access.requireWorkspace(userId, payment.workspaceId, 'view', 'payment');
		return payment;
	}
}
