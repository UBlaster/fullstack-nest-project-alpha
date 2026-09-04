import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { CacheService } from './cache.service';
import { CACHE_CONFIG, CacheConfig, REDIS_CLIENT } from './cache.tokens';

function positiveInteger(value: string | undefined, fallback: number, name: string) {
	const parsed = Number(value ?? fallback);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function enabledValue(value: string | undefined) {
	if (value === undefined) return false;
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new Error('CACHE_ENABLED must be true or false');
}

@Module({
	providers: [
		{
			provide: CACHE_CONFIG,
			inject: [ConfigService],
			useFactory: (config: ConfigService): CacheConfig => ({
				enabled: enabledValue(config.get<string>('CACHE_ENABLED')),
				projectsTtlSeconds: positiveInteger(
					config.get<string>('CACHE_PROJECTS_TTL_SECONDS'),
					60,
					'CACHE_PROJECTS_TTL_SECONDS',
				),
				searchTtlSeconds: positiveInteger(
					config.get<string>('CACHE_SEARCH_TTL_SECONDS'),
					30,
					'CACHE_SEARCH_TTL_SECONDS',
				),
				lockTtlMs: positiveInteger(
					config.get<string>('CACHE_LOCK_TTL_MS'),
					5000,
					'CACHE_LOCK_TTL_MS',
				),
			}),
		},
		{
			provide: REDIS_CLIENT,
			inject: [ConfigService, CACHE_CONFIG],
			useFactory: (config: ConfigService, cacheConfig: CacheConfig): Redis | null => {
				if (!cacheConfig.enabled) return null;
				const url = config.get<string>('REDIS_URL');
				if (!url) throw new Error('REDIS_URL is required when cache is enabled');

				const redis = new Redis(url, {
					lazyConnect: true,
					enableOfflineQueue: false,
					enableReadyCheck: true,
					maxRetriesPerRequest: 1,
					connectTimeout: 500,
					retryStrategy: () => null,
				});
				return redis;
			},
		},
		CacheService,
	],
	exports: [CacheService],
})
export class CacheModule {}
