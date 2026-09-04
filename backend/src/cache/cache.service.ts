import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { CACHE_CONFIG, CacheConfig, REDIS_CLIENT, SearchCacheParams } from './cache.tokens';

const releaseLockScript = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

interface CacheRead<T> {
	available: boolean;
	hit: boolean;
	value?: T;
}

const connectionCooldownMs = 1000;
const shutdownTimeoutMs = 500;

export function ttlWithJitter(baseTtlSeconds: number, random: () => number = Math.random) {
	const base = Math.max(1, Math.trunc(baseTtlSeconds));
	const maximumJitter = Math.floor(base * 0.1);
	const offset = Math.floor(random() * (maximumJitter * 2 + 1)) - maximumJitter;
	return Math.max(1, base + offset);
}

@Injectable()
export class CacheService implements OnModuleDestroy {
	private readonly logger = new Logger(CacheService.name);
	private connectionPromise: Promise<boolean> | null = null;
	private unavailableUntil = 0;
	private readonly lastFailureLogAt = new Map<string, number>();

	constructor(
		@Inject(REDIS_CLIENT) private readonly redis: Redis | null,
		@Inject(CACHE_CONFIG) private readonly config: CacheConfig,
	) {
		this.redis?.on('error', this.handleClientError);
	}

	get projectsTtlSeconds() {
		return this.config.projectsTtlSeconds;
	}

	get searchTtlSeconds() {
		return this.config.searchTtlSeconds;
	}

	workspaceVersionKey(workspaceId: string) {
		return `wsdocs:v1:workspace:${workspaceId}:version`;
	}

	projectsKey(workspaceId: string, version: string) {
		return `wsdocs:v1:workspace:${workspaceId}:v${version}:projects`;
	}

	searchKey(workspaceId: string, version: string, params: SearchCacheParams) {
		const canonicalParams = JSON.stringify({
			q: params.q.trim(),
			limit: params.limit,
			offset: params.offset,
		});
		const hash = createHash('sha256').update(canonicalParams).digest('hex');
		return `wsdocs:v1:workspace:${workspaceId}:v${version}:search:${hash}`;
	}

	async getWorkspaceVersion(workspaceId: string) {
		if (!this.config.enabled || !this.redis) return null;
		if (!(await this.ensureConnected())) return null;
		try {
			return (await this.redis.get(this.workspaceVersionKey(workspaceId))) ?? '0';
		} catch (error) {
			this.logFailure('version read', error);
			return null;
		}
	}

	async invalidateWorkspace(workspaceId: string) {
		if (!this.config.enabled || !this.redis) return;
		if (!(await this.ensureConnected())) return;
		try {
			await this.redis.incr(this.workspaceVersionKey(workspaceId));
		} catch (error) {
			this.logFailure('workspace invalidation', error);
		}
	}

	async remember<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
		if (!this.config.enabled || !this.redis) return load();

		const firstRead = await this.read<T>(key);
		if (firstRead.hit) return firstRead.value as T;
		if (!firstRead.available) return load();

		const lockKey = `${key}:lock`;
		const token = randomUUID();
		let acquired: string | null;
		try {
			acquired = await this.redis.set(lockKey, token, 'PX', this.config.lockTtlMs, 'NX');
		} catch (error) {
			this.logFailure('lock acquisition', error);
			return load();
		}

		if (acquired === 'OK') {
			try {
				const secondRead = await this.read<T>(key);
				if (secondRead.hit) return secondRead.value as T;

				const value = await load();
				await this.write(key, value, ttlSeconds);
				return value;
			} finally {
				await this.releaseLock(lockKey, token);
			}
		}

		for (let attempt = 0; attempt < 3; attempt += 1) {
			await delay(75 * (attempt + 1));
			const retry = await this.read<T>(key);
			if (retry.hit) return retry.value as T;
			if (!retry.available) return load();
		}

		return load();
	}

	async onModuleDestroy() {
		this.unavailableUntil = Number.POSITIVE_INFINITY;
		if (!this.redis) return;

		try {
			if (this.redis.status === 'ready') {
				await this.quitWithTimeout();
				return;
			}
		} catch (error) {
			this.logFailure('graceful shutdown', error);
		} finally {
			this.redis.off('error', this.handleClientError);
		}

		this.redis.disconnect();
	}

	private async read<T>(key: string): Promise<CacheRead<T>> {
		if (!(await this.ensureConnected())) return { available: false, hit: false };

		let raw: string | null | undefined;
		try {
			raw = await this.redis?.get(key);
		} catch (error) {
			this.logFailure('GET', error);
			return { available: false, hit: false };
		}

		if (raw === null || raw === undefined) return { available: true, hit: false };

		try {
			return { available: true, hit: true, value: JSON.parse(raw) as T };
		} catch (error) {
			this.logFailure('JSON parse', error);
			await this.deleteCorruptedKey(key);
			return { available: true, hit: false };
		}
	}

	private async write<T>(key: string, value: T, ttlSeconds: number) {
		if (!(await this.ensureConnected())) return;
		const ttl = ttlWithJitter(ttlSeconds);
		try {
			await this.redis?.set(key, JSON.stringify(value), 'EX', ttl);
		} catch (error) {
			this.logFailure('write', error);
		}
	}

	private async releaseLock(lockKey: string, token: string) {
		if (this.redis?.status !== 'ready') return;
		try {
			await this.redis?.eval(releaseLockScript, 1, lockKey, token);
		} catch (error) {
			this.logFailure('lock release', error);
		}
	}

	private logFailure(operation: string, error: unknown) {
		const now = Date.now();
		const lastLoggedAt = this.lastFailureLogAt.get(operation) ?? 0;
		if (now - lastLoggedAt < connectionCooldownMs) return;
		this.lastFailureLogAt.set(operation, now);

		const name = error instanceof Error ? error.name : 'UnknownError';
		const code =
			typeof error === 'object' && error !== null && 'code' in error
				? String(error.code)
				: undefined;
		this.logger.warn(`Cache ${operation} failed: ${name}${code ? ` (${code})` : ''}`);
	}

	private readonly handleClientError = (error: unknown) => {
		this.logFailure('client connection', error);
	};

	private async deleteCorruptedKey(key: string) {
		try {
			await this.redis?.del(key);
		} catch (error) {
			this.logFailure('corrupted key cleanup', error);
		}
	}

	private async quitWithTimeout() {
		if (!this.redis) return;
		let timeout: NodeJS.Timeout | undefined;
		const timedOut = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => reject(new Error('Redis shutdown timed out')), shutdownTimeoutMs);
			timeout.unref();
		});

		try {
			await Promise.race([this.redis.quit(), timedOut]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	private async ensureConnected() {
		if (!this.redis) return false;
		if (this.redis.status === 'ready') return true;
		if (Date.now() < this.unavailableUntil) return false;
		if (this.connectionPromise) return this.connectionPromise;

		this.connectionPromise = this.redis
			.connect()
			.then(() => true)
			.catch((error: unknown) => {
				this.unavailableUntil = Date.now() + connectionCooldownMs;
				this.redis?.disconnect();
				this.logFailure('connection', error);
				return false;
			})
			.finally(() => {
				this.connectionPromise = null;
			});
		return this.connectionPromise;
	}
}
