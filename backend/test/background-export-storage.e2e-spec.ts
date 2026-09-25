import { Readable } from 'node:stream';
import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	PutObjectCommand,
	S3Client,
	UploadPartCommand,
} from '@aws-sdk/client-s3';
import { S3ObjectStorageService } from '../src/storage/s3-object-storage.service';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('Task 6 streaming storage (real AWS Upload, no network)', () => {
	let client: S3Client;
	let storage: S3ObjectStorageService;
	beforeEach(() => {
		client = new S3Client({
			region: 'test',
			endpoint: 'https://example.invalid',
			credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
		});
		storage = new S3ObjectStorageService(client, {
			bucket: 'test',
			uploadTtlSeconds: 60,
			downloadTtlSeconds: 60,
		});
	});
	afterEach(() => {
		client.destroy();
		jest.restoreAllMocks();
	});

	it('does not start a request for an already cancelled upload', async () => {
		const send = jest.spyOn(client, 'send').mockImplementation(async () => ({}));
		const controller = new AbortController();
		controller.abort();
		await expect(
			storage.uploadStream({
				objectKey: 'export.csv',
				body: Readable.from(['csv']),
				contentType: 'text/csv',
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(send).not.toHaveBeenCalled();
	});

	it('cancellation waits for an in-flight PUT to settle before permitting object cleanup', async () => {
		const entered = deferred();
		const release = deferred();
		const controller = new AbortController();
		const send = jest.spyOn(client, 'send').mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { ETag: 'etag' };
		});
		let settled = false;
		const uploading = storage
			.uploadStream({
				objectKey: 'export.csv',
				body: Readable.from(['csv']),
				contentType: 'text/csv',
				signal: controller.signal,
			})
			.catch((error: unknown) => error)
			.finally(() => {
				settled = true;
			});
		try {
			await entered.promise;
			controller.abort();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(settled).toBe(false);
			expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
			expect(send.mock.calls[0][1]).toMatchObject({ abortSignal: controller.signal });
		} finally {
			release.resolve();
			await uploading;
		}
		expect(await uploading).toMatchObject({ name: 'AbortError' });
	});

	it('aborts multipart only after all in-flight parts settle', async () => {
		const entered = deferred();
		const release = deferred();
		const controller = new AbortController();
		const commands: unknown[] = [];
		jest.spyOn(client, 'send').mockImplementation(async (command) => {
			commands.push(command);
			if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload-id' };
			if (command instanceof UploadPartCommand) {
				entered.resolve();
				await release.promise;
				return { ETag: 'etag' };
			}
			if (command instanceof AbortMultipartUploadCommand) return {};
			throw new Error('unexpected S3 command');
		});
		let settled = false;
		const uploading = storage
			.uploadStream({
				objectKey: 'export.csv',
				body: Readable.from([Buffer.alloc(6 * 1024 * 1024)]),
				contentType: 'text/csv',
				signal: controller.signal,
			})
			.catch((error: unknown) => error)
			.finally(() => {
				settled = true;
			});
		try {
			await entered.promise;
			controller.abort();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(settled).toBe(false);
			expect(commands.some((command) => command instanceof AbortMultipartUploadCommand)).toBe(
				false,
			);
		} finally {
			release.resolve();
			await uploading;
		}
		expect(await uploading).toMatchObject({ name: 'AbortError' });
		expect(
			commands.filter((command) => command instanceof AbortMultipartUploadCommand),
		).toHaveLength(1);
		expect(commands.some((command) => command instanceof CompleteMultipartUploadCommand)).toBe(
			false,
		);
	});

	it('awaits multipart cleanup when CompleteMultipartUpload fails', async () => {
		const cleanupEntered = deferred();
		const releaseCleanup = deferred();
		const commands: unknown[] = [];
		jest.spyOn(client, 'send').mockImplementation(async (command) => {
			commands.push(command);
			if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload-id' };
			if (command instanceof UploadPartCommand) return { ETag: 'etag' };
			if (command instanceof CompleteMultipartUploadCommand) throw new Error('complete failed');
			if (command instanceof AbortMultipartUploadCommand) {
				cleanupEntered.resolve();
				await releaseCleanup.promise;
				return {};
			}
			throw new Error('unexpected S3 command');
		});
		let settled = false;
		const uploading = storage
			.uploadStream({
				objectKey: 'export.csv',
				body: Readable.from([Buffer.alloc(6 * 1024 * 1024)]),
				contentType: 'text/csv',
				signal: new AbortController().signal,
			})
			.catch((error: unknown) => error)
			.finally(() => {
				settled = true;
			});
		try {
			// Race also lets an incorrect early rejection fail without hanging the test.
			await Promise.race([cleanupEntered.promise, uploading]);
			expect(commands.some((command) => command instanceof AbortMultipartUploadCommand)).toBe(true);
			expect(settled).toBe(false);
		} finally {
			releaseCleanup.resolve();
			await uploading;
		}
		expect(await uploading).toMatchObject({ message: 'complete failed' });
	});
});
