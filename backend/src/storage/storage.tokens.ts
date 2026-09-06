import { InjectionToken } from '@nestjs/common';

export const OBJECT_STORAGE: InjectionToken = Symbol('OBJECT_STORAGE');
export const S3_CLIENT: InjectionToken = Symbol('S3_CLIENT');
export const STORAGE_CONFIG: InjectionToken = Symbol('STORAGE_CONFIG');

export interface StorageConfig {
	bucket: string;
	uploadTtlSeconds: number;
	downloadTtlSeconds: number;
}

export interface ObjectHead {
	size: number;
	contentType?: string;
	etag?: string;
}

export interface ObjectStorageService {
	createUploadUrl(input: {
		objectKey: string;
		mimeType: string;
		expiresInSeconds: number;
	}): Promise<string>;
	createDownloadUrl(input: {
		objectKey: string;
		downloadName: string;
		expiresInSeconds: number;
	}): Promise<string>;
	head(objectKey: string): Promise<ObjectHead>;
	remove(objectKey: string): Promise<void>;
	list(prefix?: string): AsyncIterable<string>;
}
