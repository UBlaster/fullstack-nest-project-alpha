import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
	UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
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
		return getSignedUrl(
			this.s3,
			new PutObjectCommand({
				Bucket: this.config.bucket,
				Key: input.objectKey,
				ContentType: input.mimeType,
			}),
			{ expiresIn: input.expiresInSeconds },
		);
	}

	createDownloadUrl(input: {
		objectKey: string;
		downloadName: string;
		expiresInSeconds: number;
	}): Promise<string> {
		const disposition = contentDisposition(input.downloadName);
		return getSignedUrl(
			this.s3,
			new GetObjectCommand({
				Bucket: this.config.bucket,
				Key: input.objectKey,
				ResponseContentDisposition: disposition,
			}),
			{ expiresIn: input.expiresInSeconds },
		);
	}

	async uploadStream(input: {
		objectKey: string;
		body: import('node:stream').Readable;
		contentType: string;
		signal: AbortSignal;
	}): Promise<void> {
		const abortError = () =>
			Object.assign(new Error('Export upload aborted'), { name: 'AbortError' });
		if (input.signal.aborted) throw abortError();
		let uploadId: string | undefined;
		let multipartAborted = false;
		// Upload.abort() races done() against an immediate rejection, not against
		// settlement of the S3 requests. Abort requests directly and let done()
		// join its bounded workers before the caller can delete the attempt object.
		const client = new Proxy(this.s3, {
			get: (target, property) => {
				if (property !== 'send') return Reflect.get(target, property, target);
				return async (
					command:
						| PutObjectCommand
						| CreateMultipartUploadCommand
						| UploadPartCommand
						| CompleteMultipartUploadCommand
						| AbortMultipartUploadCommand,
				) => {
					if (command instanceof AbortMultipartUploadCommand) {
						const result = await target.send(command);
						multipartAborted = true;
						return result;
					}
					if (input.signal.aborted) throw abortError();
					const options = { abortSignal: input.signal };
					if (command instanceof CreateMultipartUploadCommand) {
						const result = await target.send(command, options);
						uploadId = result.UploadId;
						return result;
					}
					if (command instanceof UploadPartCommand) return target.send(command, options);
					if (command instanceof PutObjectCommand) return target.send(command, options);
					return target.send(command, options);
				};
			},
		});
		const upload = new Upload({
			client,
			params: {
				Bucket: this.config.bucket,
				Key: input.objectKey,
				Body: input.body,
				ContentType: input.contentType,
			},
			queueSize: 2,
			partSize: 5 * 1024 * 1024,
			leavePartsOnError: false,
		});
		const abort = () => {
			input.body.destroy(abortError());
		};
		input.signal.addEventListener('abort', abort, { once: true });
		try {
			await upload.done();
			if (input.signal.aborted) throw abortError();
		} catch (error) {
			// Upload does not abort the multipart session if its final Complete fails.
			if (uploadId && !multipartAborted) {
				try {
					await this.s3.send(
						new AbortMultipartUploadCommand({
							Bucket: this.config.bucket,
							Key: input.objectKey,
							UploadId: uploadId,
						}),
					);
				} catch (cleanupError) {
					if (
						!isNotFound(cleanupError) &&
						!(cleanupError instanceof Error && cleanupError.name === 'NoSuchUpload')
					)
						throw cleanupError;
				}
			}
			throw error;
		} finally {
			input.signal.removeEventListener('abort', abort);
		}
	}

	async head(objectKey: string): Promise<ObjectHead> {
		const result = await this.s3.send(
			new HeadObjectCommand({
				Bucket: this.config.bucket,
				Key: objectKey,
			}),
		);
		return {
			size: result.ContentLength ?? -1,
			contentType: result.ContentType,
			etag: result.ETag?.replace(/^"|"$/g, ''),
		};
	}

	async remove(objectKey: string): Promise<void> {
		try {
			await this.s3.send(
				new DeleteObjectCommand({
					Bucket: this.config.bucket,
					Key: objectKey,
				}),
			);
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
	}

	async *list(prefix?: string): AsyncIterable<string> {
		let continuationToken: string | undefined;
		do {
			const result = await this.s3.send(
				new ListObjectsV2Command({
					Bucket: this.config.bucket,
					Prefix: prefix,
					ContinuationToken: continuationToken,
				}),
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
