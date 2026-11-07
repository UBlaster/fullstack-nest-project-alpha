import { randomUUID } from 'node:crypto';
import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { getRequestId } from '../diagnostics/request-context';
import { observeS3 } from '../diagnostics/s3-operation';
import {
	ObjectHead,
	ObjectStorageService,
	S3_CLIENT,
	STORAGE_CONFIG,
	StorageConfig,
} from './storage.tokens';

function isNotFound(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
	return candidate.name === 'NotFound' || candidate.$metadata?.httpStatusCode === 404;
}

export function contentDisposition(downloadName: string): string {
	if (/[\r\n]/.test(downloadName)) {
		throw new Error('downloadName contains control characters');
	}
	const fallback = downloadName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	const encoded = encodeURIComponent(downloadName).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

@Injectable()
export class S3ObjectStorageService implements ObjectStorageService, OnModuleDestroy {
	constructor(
		@Inject(S3_CLIENT) private readonly s3: S3Client,
		@Inject(STORAGE_CONFIG) private readonly config: StorageConfig,
	) {}

	createUploadUrl(input: {
		objectKey: string;
		mimeType: string;
		expiresInSeconds: number;
	}): Promise<string> {
		return observeS3(
			'PresignPutObject',
			() =>
				getSignedUrl(
					this.s3,
					new PutObjectCommand({
						Bucket: this.config.bucket,
						Key: input.objectKey,
						ContentType: input.mimeType,
					}),
					{ expiresIn: input.expiresInSeconds },
				),
			{ presign: true },
		);
	}

	createDownloadUrl(input: {
		objectKey: string;
		downloadName: string;
		expiresInSeconds: number;
	}): Promise<string> {
		const disposition = contentDisposition(input.downloadName);
		return observeS3(
			'PresignGetObject',
			() =>
				getSignedUrl(
					this.s3,
					new GetObjectCommand({
						Bucket: this.config.bucket,
						Key: input.objectKey,
						ResponseContentDisposition: disposition,
					}),
					{ expiresIn: input.expiresInSeconds },
				),
			{ presign: true },
		);
	}

	async head(objectKey: string): Promise<ObjectHead> {
		const result = await observeS3('HeadObject', () =>
			this.s3.send(
				new HeadObjectCommand({
					Bucket: this.config.bucket,
					Key: objectKey,
				}),
			),
		);
		return {
			size: result.ContentLength ?? -1,
			contentType: result.ContentType,
			etag: result.ETag?.replace(/^"|"$/g, ''),
		};
	}

	async remove(objectKey: string): Promise<void> {
		try {
			await observeS3('DeleteObject', () =>
				this.s3.send(
					new DeleteObjectCommand({
						Bucket: this.config.bucket,
						Key: objectKey,
					}),
				),
			);
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
	}

	async *list(prefix?: string): AsyncIterable<string> {
		const requestId = getRequestId() ?? randomUUID();
		let continuationToken: string | undefined;
		do {
			const result = await observeS3(
				'ListObjectsV2',
				() =>
					this.s3.send(
						new ListObjectsV2Command({
							Bucket: this.config.bucket,
							Prefix: prefix,
							ContinuationToken: continuationToken,
						}),
					),
				{ requestId },
			);
			for (const object of result.Contents ?? []) {
				if (object.Key) yield object.Key;
			}
			continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
		} while (continuationToken);
	}

	onModuleDestroy(): void {
		this.s3.destroy();
	}
}
