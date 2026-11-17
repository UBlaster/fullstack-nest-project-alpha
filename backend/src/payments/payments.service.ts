import { createHash, randomUUID } from 'node:crypto';
import {
	ConflictException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { AccessPolicyService } from '../access/access-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import {
	PaymentEventKey,
	PaymentTransitionService,
	terminalPayment,
} from './payment-transition.service';
import { PaymentProviderError, YooKassaPaymentProvider } from './yookassa-payment.provider';
import { paymentResponseSelect, PaymentResponseRow } from './payment-response.select';

const HOUR_MS = 60 * 60 * 1000;
export const PAYMENT_CREATE_WINDOW_MS = 23 * HOUR_MS;
const activeStatuses = ['CREATED', 'PENDING'] as const;
const paymentLookupSelect = {
	...paymentResponseSelect,
	requestHash: true,
	firstDispatchedAt: true,
	providerPaymentId: true,
} satisfies Prisma.PaymentSelect;

function paymentResponse(payment: PaymentResponseRow) {
	return {
		...payment,
		confirmationUrl:
			terminalPayment(payment.status) || payment.needsReview ? null : payment.confirmationUrl,
	};
}

export function paymentBackoff(attempts: number): number {
	return Math.min(60_000 * 2 ** Math.min(attempts, 6), HOUR_MS);
}

function safeError(error: unknown): string {
	return error instanceof PaymentProviderError ? error.code : 'PAYMENT_STORAGE_UNAVAILABLE';
}

function invalidSnapshot(error: unknown): boolean {
	return (
		error instanceof PaymentProviderError &&
		(error.code.includes('MISMATCH') ||
			error.code === 'PROVIDER_INVALID_RESPONSE' ||
			error.code === 'PROVIDER_INVALID_CONFIRMATION' ||
			error.code === 'PROVIDER_HTTP_404' ||
			error.code === 'PROVIDER_ID_ALREADY_BOUND')
	);
}

@Injectable()
export class PaymentsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly access: AccessPolicyService,
		private readonly provider: YooKassaPaymentProvider,
		private readonly transitions: PaymentTransitionService,
	) {}

	isConfigured(): boolean {
		return this.provider.isConfigured();
	}

	async capabilities(userId: string, workspaceId: string): Promise<{ enabled: boolean }> {
		await this.access.requireWorkspace(userId, workspaceId, 'view', 'payment');
		return { enabled: this.isConfigured() };
	}

	async create(userId: string, workspaceId: string, _purpose: 'WORKSPACE_DEMO', key: string) {
		await this.access.requireWorkspace(userId, workspaceId, 'create', 'payment');
		const idempotencyKey = key.toLowerCase();
		const requestHash = createHash('sha256')
			.update(
				JSON.stringify({
					workspaceId,
					purpose: 'WORKSPACE_DEMO',
					amountMinor: 10_000,
					currency: 'RUB',
				}),
			)
			.digest('hex');
		let payment = await this.prisma.payment.findUnique({
			where: { userId_idempotencyKey: { userId, idempotencyKey } },
			select: paymentLookupSelect,
		});
		let created = false;
		if (!payment) {
			this.provider.assertConfigured();
			const id = randomUUID();
			try {
				payment = await this.prisma.payment.create({
					data: {
						id,
						workspaceId,
						userId,
						purpose: 'WORKSPACE_DEMO',
						amountMinor: 10_000,
						currency: 'RUB',
						idempotencyKey,
						requestHash,
						providerIdempotenceKey: randomUUID(),
						providerRequest: this.provider.requestFor(id, workspaceId),
					},
					select: paymentLookupSelect,
				});
				created = true;
			} catch (error: unknown) {
				if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
					throw error;
				payment = await this.prisma.payment.findUniqueOrThrow({
					where: { userId_idempotencyKey: { userId, idempotencyKey } },
					select: paymentLookupSelect,
				});
			}
		}
		const { requestHash: savedRequestHash, firstDispatchedAt, ...reserved } = payment;
		if (savedRequestHash !== requestHash)
			throw new ConflictException({
				code: 'PAYMENT_KEY_CONFLICT',
				message: 'Ключ уже использован для другой покупки',
			});
		let current = reserved;
		if (created || (!firstDispatchedAt && !reserved.providerPaymentId)) {
			await this.recover(reserved.id);
			current = await this.prisma.payment.findUniqueOrThrow({
				where: { id: reserved.id },
				select: { ...paymentResponseSelect, providerPaymentId: true },
			});
		}
		const { providerPaymentId, ...response } = current;
		const known = providerPaymentId !== null || terminalPayment(response.status);
		return { payment: paymentResponse(response), statusCode: known ? (created ? 201 : 200) : 202 };
	}

	async get(userId: string, id: string) {
		return paymentResponse(await this.requirePayment(userId, id));
	}

	async history(userId: string, workspaceId: string, limit: number) {
		await this.access.requireWorkspace(userId, workspaceId, 'view', 'payment');
		const payments = await this.prisma.payment.findMany({
			where: { workspaceId },
			select: paymentResponseSelect,
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			take: limit,
		});
		return payments.map(paymentResponse);
	}

	async reconcile(userId: string, id: string) {
		await this.requirePayment(userId, id);
		this.provider.assertConfigured();
		await this.recover(id);
		return paymentResponse(
			await this.prisma.payment.findUniqueOrThrow({
				where: { id },
				select: paymentResponseSelect,
			}),
		);
	}

	// Internal recovery deliberately does not depend on the initiating user's current membership.
	async recover(id: string): Promise<void> {
		this.provider.assertConfigured();
		const now = new Date();
		const leaseToken = randomUUID();
		const claim = await this.prisma.payment.updateMany({
			where: {
				id,
				AND: [
					{
						OR: [
							{ status: { in: [...activeStatuses] } },
							{ needsReview: true, providerPaymentId: { not: null } },
						],
					},
					{ OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
				],
			},
			data: {
				leaseToken,
				leaseUntil: new Date(now.getTime() + this.provider.httpTimeoutMs() + 10_000),
				version: { increment: 1 },
			},
		});
		if (!claim.count) return;
		try {
			let payment = await this.prisma.payment.findUniqueOrThrow({ where: { id } });
			if (terminalPayment(payment.status) && !payment.needsReview) return;
			if (!payment.providerPaymentId) {
				if (
					payment.firstDispatchedAt &&
					Date.now() - payment.firstDispatchedAt.getTime() >= PAYMENT_CREATE_WINDOW_MS
				) {
					await this.prisma.payment.updateMany({
						where: { id, leaseToken, status: { in: [...activeStatuses] }, providerPaymentId: null },
						data: {
							needsReview: true,
							lastErrorCode: 'PROVIDER_CREATE_WINDOW_EXPIRED',
							version: { increment: 1 },
						},
					});
					return;
				}
				const dispatchTime = new Date();
				const dispatched = await this.prisma.payment.updateMany({
					where: {
						id,
						leaseToken,
						leaseUntil: { gt: dispatchTime },
						providerPaymentId: null,
						status: { in: [...activeStatuses] },
						OR: [
							{ firstDispatchedAt: null },
							{
								firstDispatchedAt: {
									gt: new Date(dispatchTime.getTime() - PAYMENT_CREATE_WINDOW_MS),
								},
							},
						],
					},
					data: {
						firstDispatchedAt: payment.firstDispatchedAt ?? dispatchTime,
						createAttempts: { increment: 1 },
						version: { increment: 1 },
					},
				});
				if (!dispatched.count) return;
				payment = await this.prisma.payment.findUniqueOrThrow({ where: { id } });
				// Check the fixed safety window again immediately before every outgoing POST.
				if (
					!payment.firstDispatchedAt ||
					Date.now() - payment.firstDispatchedAt.getTime() >= PAYMENT_CREATE_WINDOW_MS
				)
					return;
			}
			if (
				payment.leaseToken !== leaseToken ||
				!payment.leaseUntil ||
				payment.leaseUntil <= new Date() ||
				(terminalPayment(payment.status) && !payment.needsReview)
			)
				return;
			const value = payment.providerPaymentId
				? await this.provider.get(payment.providerPaymentId)
				: await this.provider.create(payment.providerRequest, payment.providerIdempotenceKey);
			await this.transitions.apply(
				id,
				value,
				payment.providerPaymentId ? 'RECONCILE' : 'CREATE_RESPONSE',
				leaseToken,
				undefined,
				leaseToken,
			);
		} catch (error: unknown) {
			// Preserve an early webhook's terminal state. Failures never manufacture FAILED.
			await this.prisma.payment.updateMany({
				where: { id, leaseToken, status: { in: [...activeStatuses] } },
				data: {
					lastErrorCode: safeError(error),
					...(invalidSnapshot(error) ||
					(error instanceof PaymentProviderError && /^PROVIDER_HTTP_4/.test(error.code))
						? { needsReview: true }
						: {}),
					version: { increment: 1 },
				},
			});
			if (!(error instanceof PaymentProviderError)) throw error;
		} finally {
			const current = await this.prisma.payment.findUniqueOrThrow({
				where: { id },
				select: { reconcileAttempts: true },
			});
			await this.prisma.payment.updateMany({
				where: { id, leaseToken },
				data: {
					leaseToken: null,
					leaseUntil: null,
					reconcileAttempts: { increment: 1 },
					nextReconcileAt: new Date(Date.now() + paymentBackoff(current.reconcileAttempts)),
				},
			});
		}
	}

	async webhook(
		eventType: string,
		providerObjectId: string,
		eventLeaseToken?: string,
	): Promise<void> {
		const event = {
			eventType,
			providerObjectId,
			...(eventLeaseToken ? { leaseToken: eventLeaseToken } : {}),
		};
		try {
			const value = await this.provider.get(providerObjectId);
			if (!isUUID(value.metadata.paymentId))
				throw new PaymentProviderError('PROVIDER_METADATA_MISMATCH');
			const payment = await this.prisma.payment.findUnique({
				where: { id: value.metadata.paymentId },
				select: { id: true },
			});
			if (!payment) {
				if (value.amount.value !== '100.00' || value.amount.currency !== 'RUB')
					throw new PaymentProviderError('PROVIDER_AMOUNT_MISMATCH');
				await this.transitions.recordEvent(this.prisma, event, null, 'UNMATCHED');
				return;
			}
			await this.transitions.apply(
				payment.id,
				value,
				'VERIFIED_WEBHOOK',
				`${eventType}:${providerObjectId}`,
				event,
			);
		} catch (error: unknown) {
			if (error instanceof PaymentProviderError && error.code === 'PAYMENT_EVENT_LEASE_LOST')
				throw error;
			if (invalidSnapshot(error)) {
				await this.transitions.recordEvent(this.prisma, event, null, 'IGNORED', safeError(error));
				return;
			}
			// A durable pending event allows recovery even if delivery retries are exhausted.
			await this.transitions.recordEvent(
				this.prisma,
				event,
				null,
				'RETRY_PENDING',
				safeError(error),
			);
			throw new ServiceUnavailableException({
				code: 'PAYMENT_VERIFICATION_UNAVAILABLE',
				message: 'Проверка платежа временно недоступна',
			});
		}
	}

	async recoverEvent(event: PaymentEventKey): Promise<void> {
		await this.webhook(event.eventType, event.providerObjectId, event.leaseToken);
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
