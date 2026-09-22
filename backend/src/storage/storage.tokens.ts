import { InjectionToken } from '@nestjs/common';
import { Readable } from 'node:stream';

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
	uploadStream(input: {
		objectKey: string;
		body: Readable;
		contentType: string;
		signal: AbortSignal;
	}): Promise<void>;
	head(objectKey: string): Promise<ObjectHead>;
	remove(objectKey: string): Promise<void>;
	list(prefix?: string): AsyncIterable<string>;
}
