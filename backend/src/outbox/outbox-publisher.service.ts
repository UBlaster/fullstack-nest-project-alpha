import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEvent } from '@prisma/client';
import { withMessageContext } from '../observability/carrier';
import { withSpan } from '../observability/telemetry';
import { PrismaService } from '../prisma/prisma.service';
import { ExportQueuePayload, parsePipelineJob } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class OutboxPublisherService {
	private readonly leaseMs: number;

	constructor(
		private readonly prisma: PrismaService,
		private readonly queue: QueueService,
		config: ConfigService,
	) {
		this.leaseMs = this.positiveInteger(config, 'EXPORT_OUTBOX_LEASE_MS', 30_000);
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
			if (await this.dispatch(event, now, leaseCutoff)) published += 1;
		}
		return published;
	}

	// Worker only ACKs the triggering delivery after its retry/DLQ publication is confirmed.
	// If the polling dispatcher owns the claim, redelivery will observe its durable receipt.
	async confirmPipelineDispatch(aggregateId: string): Promise<void> {
		const where = { type_aggregateId: { type: 'PIPELINE_STAGE' as const, aggregateId } };
		const event = await this.prisma.outboxEvent.findUniqueOrThrow({ where });
		if (event.publishedAt) return;
		const now = new Date();
		if (await this.dispatch(event, now, new Date(now.getTime() - this.leaseMs))) return;
		const receipt = await this.prisma.outboxEvent.findUniqueOrThrow({
			where,
			select: { publishedAt: true },
		});
		if (!receipt.publishedAt) throw new Error('PipelinePublicationUnconfirmed');
	}

	private dispatch(event: OutboxEvent, now: Date, leaseCutoff: Date): Promise<boolean> {
		const value = event.payload;
		const carrier =
			value && typeof value === 'object' && !Array.isArray(value) ? value.carrier : null;
		return withMessageContext(carrier, () =>
			withSpan('outbox.dispatch', () => this.publishOne(event, now, leaseCutoff)),
		);
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
			await this.publishEvent(event);
			const receipt = await this.prisma.outboxEvent.updateMany({
				where: { id: event.id, publishedAt: null, claimToken },
				data: {
					publishedAt: new Date(),
					claimedAt: null,
					claimToken: null,
					lastErrorCode: null,
				},
			});
			return receipt.count === 1;
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

	private async publishEvent(event: OutboxEvent): Promise<void> {
		if (event.type === 'PIPELINE_STAGE') {
			const value = event.payload;
			if (!value || typeof value !== 'object' || Array.isArray(value))
				throw new Error('InvalidOutboxPayload');
			const job = parsePipelineJob(value);
			const delivery = value.delivery;
			if (delivery !== 'stage' && delivery !== 'retry' && delivery !== 'dead')
				throw new Error('InvalidPipelineDestination');
			await this.queue.publishPipeline(
				delivery,
				job,
				event.aggregateId,
				typeof value.retryNumber === 'number' ? value.retryNumber : 0,
				typeof value.errorCode === 'string' ? value.errorCode : undefined,
			);
			return;
		}
		const payload = this.parsePayload(event.payload);
		const domainJob = await this.prisma.exportJob.findUniqueOrThrow({
			where: { id: payload.exportJobId },
			select: { queueJobId: true },
		});
		await this.queue.addExport(payload, domainJob.queueJobId);
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

	protected errorName(error: unknown): string {
		return error instanceof Error ? error.name : 'UnknownError';
	}

	protected positiveInteger(config: ConfigService, name: string, fallback: number): number {
		const value = Number(config.get<string>(name) ?? fallback);
		if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be positive`);
		return value;
	}
}
