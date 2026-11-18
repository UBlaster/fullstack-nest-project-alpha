import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { WORKSPACE_PAYMENT_PRICE } from './payment-provider';
import { paymentBackoff, PaymentRecoveryService } from './payment-recovery.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { updateCurrent } from './update-current';

const BATCH_SIZE = 50;
const MINIMUM_PAYMENT_AGE_MS = 120_000;
const DEFAULT_INTERVAL_MS = 60_000;
const retryableResults = ['UNMATCHED', 'RETRY_PENDING'];

@Injectable()
export class PaymentMaintenanceService implements OnModuleDestroy {
	private readonly logger = new Logger(PaymentMaintenanceService.name);
	private timer?: NodeJS.Timeout;
	private running?: Promise<void>;
	private stopping = false;

	constructor(
		private readonly recovery: PaymentRecoveryService,
		private readonly webhooks: PaymentWebhookService,
		private readonly prisma: PrismaService,
		private readonly config: ConfigService,
	) {}

	start(): void {
		if (this.timer) return;
		this.stopping = false;
		const configured = Number(this.config.get<string>('PAYMENT_RECONCILE_INTERVAL_MS'));
		const interval =
			Number.isInteger(configured) && configured >= 1000 ? configured : DEFAULT_INTERVAL_MS;
		const tick = () => {
			void this.runOnce().catch(() => this.logger.warn('Payment maintenance unavailable'));
		};
		this.timer = setInterval(tick, interval);
		this.timer.unref();
		tick();
	}

	runOnce(): Promise<void> {
		if (this.running) return this.running;
		if (this.stopping) return Promise.resolve();
		this.running = this.processDue().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}

	async stop(): Promise<void> {
		this.stopping = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.running;
	}

	async onModuleDestroy(): Promise<void> {
		await this.stop();
	}

	private async processDue(): Promise<void> {
		if (!this.recovery.isConfigured()) return;
		await this.recoverPayments();
		if (!this.stopping) await this.recoverEvents();
	}

	private async recoverPayments() {
		const now = new Date();
		const payments = await this.prisma.payment.findMany({
			where: {
				provider: WORKSPACE_PAYMENT_PRICE.provider,
				status: { in: ['CREATED', 'PENDING'] },
				createdAt: { lte: new Date(now.getTime() - MINIMUM_PAYMENT_AGE_MS) },
				nextReconcileAt: { lte: now },
				OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
				NOT: {
					providerPaymentId: null,
					needsReview: true,
					lastErrorCode: 'PROVIDER_CREATE_WINDOW_EXPIRED',
				},
			},
			select: { id: true },
			orderBy: [{ nextReconcileAt: 'asc' }, { id: 'asc' }],
			take: BATCH_SIZE,
		});
		for (const { id } of payments) {
			if (this.stopping) return;
			try {
				await this.recovery.recover(id, now);
			} catch {
				this.logger.warn('Payment recovery deferred');
			}
		}
	}

	private async recoverEvents() {
		const dueAt = new Date();
		const events = await this.prisma.paymentEvent.findMany({
			where: {
				provider: WORKSPACE_PAYMENT_PRICE.provider,
				result: { in: retryableResults },
				nextReconcileAt: { lte: dueAt },
				OR: [{ leaseUntil: null }, { leaseUntil: { lte: dueAt } }],
			},
			select: { id: true },
			orderBy: [{ nextReconcileAt: 'asc' }, { id: 'asc' }],
			take: BATCH_SIZE,
		});
		for (const { id } of events) {
			if (this.stopping) return;
			try {
				await this.recoverEvent(id, dueAt);
			} catch {
				this.logger.warn('Payment event recovery deferred');
			}
		}
	}

	private async recoverEvent(id: string, dueAt: Date) {
		const leaseToken = randomUUID();
		const now = new Date();
		const event = await updateCurrent(
			this.prisma.paymentEvent.update({
				where: {
					id,
					result: { in: retryableResults },
					nextReconcileAt: { lte: dueAt },
					OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
				},
				data: { leaseToken, leaseUntil: new Date(now.getTime() + this.recovery.leaseDurationMs()) },
				select: { eventType: true, providerObjectId: true, attempts: true },
			}),
		);
		if (!event) return;

		try {
			await this.webhooks.recoverEvent({ ...event, leaseToken });
		} finally {
			const completedAt = new Date();
			await updateCurrent(
				this.prisma.paymentEvent.update({
					where: { id, leaseToken, leaseUntil: { gt: completedAt } },
					data: {
						leaseToken: null,
						leaseUntil: null,
						attempts: { increment: 1 },
						nextReconcileAt: new Date(completedAt.getTime() + paymentBackoff(event.attempts)),
					},
					select: { id: true },
				}),
			);
		}
	}
}
