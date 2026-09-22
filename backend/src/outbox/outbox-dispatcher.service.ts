import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEvent } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExportQueuePayload } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class OutboxDispatcherService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(OutboxDispatcherService.name);
	private readonly pollMs: number;
	private readonly leaseMs: number;
	private timer?: NodeJS.Timeout;
	private running = false;

	constructor(
		private readonly prisma: PrismaService,
		private readonly queue: QueueService,
		config: ConfigService,
	) {
		this.pollMs = this.positiveInteger(config, 'EXPORT_OUTBOX_POLL_MS', 1_000);
		this.leaseMs = this.positiveInteger(config, 'EXPORT_OUTBOX_LEASE_MS', 30_000);
	}

	onModuleInit(): void {
		this.timer = setInterval(() => void this.tick(), this.pollMs);
		this.timer.unref();
		void this.tick();
	}

	onModuleDestroy(): void {
		if (this.timer) clearInterval(this.timer);
	}

	async publishPending(now = new Date()): Promise<number> {
		const leaseCutoff = new Date(now.getTime() - this.leaseMs);
		const events = await this.prisma.outboxEvent.findMany({
			where: {
				publishedAt: null,
				availableAt: { lte: now },
				OR: [{ claimedAt: null }, { claimedAt: { lt: leaseCutoff } }],
			},
			orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
			take: 20,
		});
		let published = 0;
		for (const event of events) {
			if (await this.publishOne(event, now, leaseCutoff)) published += 1;
		}
		return published;
	}

	private async tick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			await this.publishPending();
		} catch (error) {
			this.logger.warn(`Outbox dispatch failed: ${this.errorName(error)}`);
		} finally {
			this.running = false;
		}
	}

	private async publishOne(event: OutboxEvent, now: Date, leaseCutoff: Date): Promise<boolean> {
		const claimToken = randomUUID();
		const claim = await this.prisma.outboxEvent.updateMany({
			where: {
				id: event.id,
				publishedAt: null,
				availableAt: { lte: now },
				OR: [{ claimedAt: null }, { claimedAt: { lt: leaseCutoff } }],
			},
			data: { claimedAt: now, claimToken },
		});
		if (claim.count === 0) return false;

		try {
			const payload = this.parsePayload(event.payload);
			const domainJob = await this.prisma.exportJob.findUniqueOrThrow({
				where: { id: payload.exportJobId },
				select: { queueJobId: true },
			});
			await this.queue.addExport(payload, domainJob.queueJobId);
			await this.prisma.outboxEvent.updateMany({
				where: { id: event.id, publishedAt: null, claimToken },
				data: {
					publishedAt: new Date(),
					claimedAt: null,
					claimToken: null,
					lastErrorCode: null,
				},
			});
			return true;
		} catch (error) {
			const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(event.attempts, 6));
			await this.prisma.outboxEvent.updateMany({
				where: { id: event.id, publishedAt: null, claimToken },
				data: {
					claimedAt: null,
					claimToken: null,
					attempts: { increment: 1 },
					lastErrorCode: this.errorName(error).slice(0, 100),
					availableAt: new Date(Date.now() + delayMs),
				},
			});
			return false;
		}
	}

	private parsePayload(value: unknown): ExportQueuePayload {
		if (
			typeof value !== 'object' ||
			value === null ||
			!('exportJobId' in value) ||
			typeof value.exportJobId !== 'string' ||
			!('schemaVersion' in value) ||
			value.schemaVersion !== 1
		) {
			throw new Error('InvalidOutboxPayload');
		}
		return { exportJobId: value.exportJobId, schemaVersion: 1 };
	}

	private errorName(error: unknown): string {
		return error instanceof Error ? error.name : 'UnknownError';
	}

	private positiveInteger(config: ConfigService, name: string, fallback: number): number {
		const value = Number(config.get<string>(name) ?? fallback);
		if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be positive`);
		return value;
	}
}
