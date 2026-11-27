import { Logger } from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';

// Each queue has its own channel, unacknowledged deliveries and reconnect lifecycle.
export class RabbitConsumer {
	private readonly logger = new Logger(RabbitConsumer.name);
	private readonly pending = new Set<Promise<void>>();
	private channel?: Channel;
	private consumerTag?: string;
	private reconnectTimer?: NodeJS.Timeout;
	private connecting?: Promise<void>;
	private stopping = true;

	constructor(
		private readonly queueName: string,
		private readonly openChannel: () => Promise<Channel>,
		private readonly handle: (channel: Channel, message: ConsumeMessage) => Promise<void>,
	) {}

	start(): void {
		if (!this.stopping) return;
		this.stopping = false;
		this.connect();
	}

	private connect(): void {
		if (this.stopping || this.connecting || this.channel) return;
		this.connecting = this.consume()
			.catch(() => {
				this.logger.warn('RabbitMQ consumer unavailable; reconnecting');
				this.scheduleReconnect();
			})
			.finally(() => {
				this.connecting = undefined;
			});
	}

	private async consume(): Promise<void> {
		await Promise.allSettled([...this.pending]);
		if (this.stopping) return;
		const channel = await this.openChannel();
		let closed = false;
		channel.on('error', () => this.logger.warn('RabbitMQ consumer channel error'));
		channel.on('close', () => {
			closed = true;
			if (this.channel === channel) {
				this.channel = undefined;
				this.consumerTag = undefined;
				this.scheduleReconnect();
			}
		});
		this.channel = channel;
		try {
			await channel.prefetch(2);
			if (closed) throw new Error('RabbitMQConsumerClosed');
			if (this.stopping) {
				await channel.close();
				return;
			}
			const consumer = await channel.consume(
				this.queueName,
				(message) => {
					if (!message) {
						void channel.close().catch(() => {});
						return;
					}
					if (this.stopping || closed) return;
					const pending = this.handle(channel, message).catch(() => {
						this.logger.warn('RabbitMQ delivery unfinished; requeueing on channel close');
						return channel.close().catch(() => {});
					});
					this.pending.add(pending);
					void pending.finally(() => this.pending.delete(pending));
				},
				{ noAck: false },
			);
			if (closed) throw new Error('RabbitMQConsumerClosed');
			this.consumerTag = consumer.consumerTag;
		} catch (error) {
			await channel.close().catch(() => {});
			throw error;
		}
	}

	private scheduleReconnect(): void {
		if (this.stopping || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect();
		}, 1_000);
		this.reconnectTimer.unref();
	}

	async close(force = false): Promise<void> {
		this.stopping = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		await this.connecting;
		const channel = this.channel;
		if (channel && this.consumerTag) await channel.cancel(this.consumerTag).catch(() => {});
		if (force) await channel?.close().catch(() => {});
		await Promise.allSettled([...this.pending]);
		if (!force) await channel?.close().catch(() => {});
		this.channel = undefined;
		this.consumerTag = undefined;
	}
}
