import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { S3ObjectStorageService } from './s3-object-storage.service';
import { OBJECT_STORAGE, S3_CLIENT, STORAGE_CONFIG, StorageConfig } from './storage.tokens';

function required(config: ConfigService, name: string): string {
	const value = config.get<string>(name);
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function positiveInteger(config: ConfigService, name: string, fallback: number): number {
	const parsed = Number(config.get<string>(name) ?? fallback);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function booleanValue(config: ConfigService, name: string, fallback: boolean): boolean {
	const value = config.get<string>(name);
	if (value === undefined) return fallback;
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new Error(`${name} must be true or false`);
}

@Module({
	providers: [
		{
			provide: STORAGE_CONFIG,
			inject: [ConfigService],
			useFactory: (config: ConfigService): StorageConfig => ({
				bucket: required(config, 'S3_BUCKET'),
				uploadTtlSeconds: positiveInteger(config, 'S3_UPLOAD_TTL_SECONDS', 600),
				downloadTtlSeconds: positiveInteger(config, 'S3_DOWNLOAD_TTL_SECONDS', 300),
			}),
		},
		{
			provide: S3_CLIENT,
			inject: [ConfigService],
			useFactory: (config: ConfigService) =>
				new S3Client({
					endpoint: required(config, 'S3_ENDPOINT'),
					region: config.get<string>('S3_REGION') ?? 'ru-central1',
					forcePathStyle: booleanValue(config, 'S3_FORCE_PATH_STYLE', false),
					credentials: {
						accessKeyId: required(config, 'S3_ACCESS_KEY_ID'),
						secretAccessKey: required(config, 'S3_SECRET_ACCESS_KEY'),
					},
				}),
		},
		S3ObjectStorageService,
		{
			provide: OBJECT_STORAGE,
			useExisting: S3ObjectStorageService,
		},
	],
	exports: [OBJECT_STORAGE, STORAGE_CONFIG],
})
export class StorageModule {}
