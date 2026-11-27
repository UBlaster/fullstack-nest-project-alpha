import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { OutboxPublisherService } from './outbox-publisher.service';

@Injectable()
export class OutboxDispatcherService
	extends OutboxPublisherService
	implements OnModuleInit, OnModuleDestroy
{
	private readonly logger = new Logger(OutboxDispatcherService.name);
	private readonly pollMs: number;
	private timer?: NodeJS.Timeout;
	private running = false;

	constructor(prisma: PrismaService, queue: QueueService, config: ConfigService) {
		super(prisma, queue, config);
		this.pollMs = this.positiveInteger(config, 'EXPORT_OUTBOX_POLL_MS', 1_000);
	}

	onModuleInit(): void {
		this.timer = setInterval(() => void this.tick(), this.pollMs);
		this.timer.unref();
		void this.tick();
	}

	onModuleDestroy(): void {
		if (this.timer) clearInterval(this.timer);
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
}
