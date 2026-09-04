export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const CACHE_CONFIG = Symbol('CACHE_CONFIG');

export interface CacheConfig {
	enabled: boolean;
	projectsTtlSeconds: number;
	searchTtlSeconds: number;
	lockTtlMs: number;
}

export interface SearchCacheParams {
	q: string;
	limit: number;
	offset: number;
}
