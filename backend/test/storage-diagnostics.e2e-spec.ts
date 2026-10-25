import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import {
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	S3Client,
	UploadPartCommand,
} from '@aws-sdk/client-s3';
import { S3ObjectStorageService } from '../src/storage/s3-object-storage.service';

describe('S3 adapter diagnostics (real SDK/presigner, no network/database)', () => {
	let client: S3Client;
	let storage: S3ObjectStorageService;
	let logged: jest.SpyInstance;

	beforeEach(() => {
		client = new S3Client({
			region: 'test',
			endpoint: 'https://example.invalid',
			credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
		});
		storage = new S3ObjectStorageService(client, {
			bucket: 'test',
			uploadTtlSeconds: 600,
			downloadTtlSeconds: 300,
		});
		logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
		jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
	});

	afterEach(() => {
		client.destroy();
		jest.restoreAllMocks();
	});

	it('keeps real presigned URLs out of logs and does not send them to S3', async () => {
		const send = jest.spyOn(client, 'send');
		const uploadUrl = await storage.createUploadUrl({
			objectKey: 'private-object-key',
			mimeType: 'text/plain',
			expiresInSeconds: 600,
		});
		const downloadUrl = await storage.createDownloadUrl({
			objectKey: 'private-object-key',
			downloadName: 'private-name.txt',
			expiresInSeconds: 300,
		});
		expect(new URL(uploadUrl).searchParams.has('X-Amz-Signature')).toBe(true);
		expect(new URL(downloadUrl).searchParams.get('X-Amz-Expires')).toBe('300');
		expect(send).not.toHaveBeenCalled();
		expect(JSON.stringify(logged.mock.calls)).not.toMatch(/private|Signature|https:/);
		expect(logged.mock.calls.map(([entry]) => JSON.parse(entry).operation)).toEqual([
			'PresignPutObject',
			'PresignGetObject',
		]);
	});

	it('preserves HEAD input/output and reports final SDK retry metadata', async () => {
		const send = jest.spyOn(client, 'send').mockImplementation(async () => ({
			ContentLength: 3,
			ContentType: 'text/plain',
			ETag: '"etag"',
			$metadata: { httpStatusCode: 200, requestId: 'aws-head', attempts: 2 },
		}));
		await expect(storage.head('private-object-key')).resolves.toEqual({
			size: 3,
			contentType: 'text/plain',
			etag: 'etag',
		});
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
		expect((send.mock.calls[0][0] as HeadObjectCommand).input.Key).toBe('private-object-key');
		expect(JSON.parse(logged.mock.calls[0][0])).toMatchObject({
			operation: 'HeadObject',
			httpStatusCode: 200,
			awsRequestId: 'aws-head',
			attempts: 2,
		});
	});

	it('keeps the original HEAD error and existing idempotent missing-object delete behavior', async () => {
		const error = Object.assign(new Error('private failure detail'), {
			name: 'NotFound',
			$metadata: { httpStatusCode: 404, requestId: 'aws-missing', attempts: 1 },
		});
		jest.spyOn(client, 'send').mockImplementation(async () => {
			throw error;
		});
		await expect(storage.head('private-object-key')).rejects.toBe(error);
		await expect(storage.remove('private-object-key')).resolves.toBeUndefined();
	});

	it('uses one correlation id across lazy listing pages without extra requests', async () => {
		const send = jest.spyOn(client, 'send').mockImplementation(async (command) => {
			const cursor = (command as ListObjectsV2Command).input.ContinuationToken;
			return cursor
				? { Contents: [{ Key: 'second' }], IsTruncated: false }
				: { Contents: [{ Key: 'first' }], IsTruncated: true, NextContinuationToken: 'next' };
		});
		const keys: string[] = [];
		for await (const key of storage.list('workspaces/test/')) keys.push(key);
		expect(keys).toEqual(['first', 'second']);
		expect(send).toHaveBeenCalledTimes(2);
		const entries = logged.mock.calls.map(([entry]) => JSON.parse(entry));
		expect(new Set(entries.map((entry) => entry.requestId)).size).toBe(1);
		expect(entries.map((entry) => entry.operation)).toEqual(['ListObjectsV2', 'ListObjectsV2']);
	});

	it('correlates multipart commands while retaining the existing AWS Upload transport', async () => {
		jest.spyOn(client, 'send').mockImplementation(async (command) => {
			const $metadata = { httpStatusCode: 200, requestId: 'aws-upload', attempts: 1 };
			if (command instanceof CreateMultipartUploadCommand)
				return { UploadId: 'upload-id', $metadata };
			if (command instanceof UploadPartCommand) return { ETag: 'etag', $metadata };
			if (command instanceof CompleteMultipartUploadCommand) return { $metadata };
			throw new Error('unexpected S3 command');
		});
		await storage.uploadStream({
			objectKey: 'private-export-key',
			body: Readable.from([Buffer.alloc(6 * 1024 * 1024)]),
			contentType: 'text/csv',
			signal: new AbortController().signal,
		});
		const entries = logged.mock.calls.map(([entry]) => JSON.parse(entry));
		expect(entries.map((entry) => entry.operation)).toEqual([
			'CreateMultipartUpload',
			'UploadPart',
			'UploadPart',
			'CompleteMultipartUpload',
		]);
		expect(new Set(entries.map((entry) => entry.requestId)).size).toBe(1);
		expect(JSON.stringify(entries)).not.toMatch(/private|Body|UploadId/);
	});
});
