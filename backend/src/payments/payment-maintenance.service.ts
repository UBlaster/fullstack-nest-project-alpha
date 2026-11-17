import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { paymentBackoff, PaymentsService } from './payments.service';

@Injectable()
export class PaymentMaintenanceService implements OnModuleDestroy {
	private readonly logger = new Logger(PaymentMaintenanceService.name);
	private timer?: NodeJS.Timeout;
	private running?: Promise<number>;
	private stopping = false;
	constructor(
		private readonly payments: PaymentsService,
		private readonly prisma: PrismaService,
		private readonly config: ConfigService,
	) {}

	start(): void {
		if (this.timer) return;
		this.stopping = false;
		const configured = Number(this.config.get<string>('PAYMENT_RECONCILE_INTERVAL_MS') ?? 60_000);
		const interval = Number.isInteger(configured) && configured >= 1000 ? configured : 60_000;
		const tick = () => {
			void this.runOnce().catch(() => this.logger.warn('Payment maintenance unavailable'));
		};
		this.timer = setInterval(tick, interval);
		this.timer.unref();
		tick();
	}

	runOnce(): Promise<number> {
		if (this.running) return this.running;
		if (this.stopping) return Promise.resolve(0);
		this.running = this.pass().finally(() => {
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

	private async pass(): Promise<number> {
		if (!this.payments.isConfigured()) return 0;
		const now = new Date();
		const payments = await this.prisma.payment.findMany({
			where: {
				status: { in: ['CREATED', 'PENDING'] },
				createdAt: { lte: new Date(now.getTime() - 120_000) },
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
			take: 50,
		});
		let processed = 0;
		// Sequential I/O is an explicit concurrency bound of one per worker.
		for (const payment of payments) {
			if (this.stopping) break;
			try {
				await this.payments.recover(payment.id);
				processed++;
			} catch {
				this.logger.warn('Payment recovery deferred');
			}
		}
		if (this.stopping) return processed;
		const events = await this.prisma.paymentEvent.findMany({
			where: {
				result: { in: ['UNMATCHED', 'RETRY_PENDING'] },
				nextReconcileAt: { lte: new Date() },
				OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
			},
			orderBy: [{ nextReconcileAt: 'asc' }, { id: 'asc' }],
			take: 50,
		});
		for (const event of events) {
			if (this.stopping) break;
			const leaseToken = randomUUID();
			const claim = await this.prisma.paymentEvent.updateMany({
				where: {
					id: event.id,
					result: { in: ['UNMATCHED', 'RETRY_PENDING'] },
					OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
				},
				data: { leaseToken, leaseUntil: new Date(Date.now() + 30_000) },
			});
			if (!claim.count) continue;
			try {
				await this.payments.recoverEvent({ ...event, leaseToken });
				processed++;
			} catch {
				this.logger.warn('Payment event recovery deferred');
			} finally {
				await this.prisma.paymentEvent.updateMany({
					where: { id: event.id, leaseToken },
					data: {
						leaseToken: null,
						leaseUntil: null,
						attempts: { increment: 1 },
						nextReconcileAt: new Date(Date.now() + paymentBackoff(event.attempts)),
					},
				});
			}
		}
		return processed;
	}
}
