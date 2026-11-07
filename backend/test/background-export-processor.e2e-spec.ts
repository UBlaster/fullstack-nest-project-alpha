import { ExportJob, ExportJobStatus } from '@prisma/client';
import { DocumentsExportService } from '../src/documents/documents-export.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ObjectStorageService } from '../src/storage/storage.tokens';
import { ExportDatabaseError, ExportLeaseLostError } from '../src/worker/export-errors';
import { ExportProcessorService } from '../src/worker/export-processor.service';
import { isolatedConfig } from './test-config';

describe('Export processor failure windows (no DB/network)', () => {
	afterEach(() => jest.restoreAllMocks());
	let current: ExportJob;
	let processor: ExportProcessorService;
	let prisma: {
		exportJob: { findUnique: jest.Mock; updateMany: jest.Mock };
		workspace: { findUnique: jest.Mock };
		workspaceMember: { findUnique: jest.Mock };
		document: { count: jest.Mock };
	};
	let storage: { uploadStream: jest.Mock; remove: jest.Mock };
	let objects: Set<string>;
	const delivery = {
		data: { exportJobId: 'test-export', schemaVersion: 1 as const },
		attemptsMade: 0,
	};

	beforeEach(() => {
		current = {
			id: 'test-export',
			workspaceId: 'workspace',
			requestedById: 'author',
			queueJobId: 'export-test-export',
			filters: { schemaVersion: 1 },
			status: ExportJobStatus.QUEUED,
			attempts: 0,
			progress: 0,
			objectKey: null,
			processingToken: null,
			heartbeatAt: null,
			errorCode: null,
			cancelRequestedAt: null,
			startedAt: null,
			finishedAt: null,
			expiresAt: null,
			expiredAt: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		prisma = {
			exportJob: {
				findUnique: jest.fn().mockImplementation(async () => ({ ...current })),
				updateMany: jest.fn().mockImplementation(async ({ data }) => {
					const attempts = data.attempts?.increment
						? current.attempts + data.attempts.increment
						: (data.attempts ?? current.attempts);
					Object.assign(current, data, { attempts });
					return { count: 1 };
				}),
			},
			workspace: { findUnique: jest.fn().mockResolvedValue({ id: 'workspace' }) },
			workspaceMember: { findUnique: jest.fn().mockResolvedValue({ role: 'MEMBER' }) },
			document: { count: jest.fn().mockResolvedValue(0) },
		};
		objects = new Set();
		storage = {
			uploadStream: jest.fn().mockImplementation(async ({ objectKey, body }) => {
				for await (const chunk of body) expect(chunk.length).toBeGreaterThan(0);
				objects.add(objectKey);
			}),
			remove: jest.fn().mockImplementation(async (key: string) => {
				objects.delete(key);
			}),
		};
		processor = new ExportProcessorService(
			prisma as unknown as PrismaService,
			{
				async *iterateForExport() {},
			} as unknown as DocumentsExportService,
			storage as unknown as ObjectStorageService,
			isolatedConfig({ EXPORT_HEARTBEAT_THROTTLE_MS: '10' }),
		);
	});

	it('does not claim a sixth attempt after stale recovery with an old transport header', async () => {
		current.attempts = 5;
		await expect(processor.process(delivery)).rejects.toThrow();
		expect(current).toMatchObject({
			status: 'FAILED',
			attempts: 5,
			errorCode: 'RETRIES_EXHAUSTED',
		});
		expect(storage.uploadStream).not.toHaveBeenCalled();
		expect(prisma.exportJob.updateMany.mock.calls.some(([args]) => args.data.processingToken)).toBe(
			false,
		);
	});

	it.each(['COMPLETED', 'FAILED', 'CANCELLED'] as const)(
		'does not repeat domain or storage work for terminal %s deliveries',
		async (status) => {
			current.status = status;
			current.objectKey = 'workspaces/workspace/exports/test-export/winner.csv';
			objects.add(current.objectKey);
			await processor.process(delivery);
			expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled();
			expect(prisma.exportJob.updateMany).not.toHaveBeenCalled();
			expect(storage.uploadStream).not.toHaveBeenCalled();
			expect(storage.remove).not.toHaveBeenCalled();
			expect(objects.has(current.objectKey)).toBe(true);
		},
	);

	it.each([{}, null, { schemaVersion: 2 }])(
		'permanently rejects an invalid filter snapshot %j before claim or storage',
		async (filters) => {
			current.filters = filters as ExportJob['filters'];
			await expect(processor.process(delivery)).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
			expect(current).toMatchObject({
				status: 'FAILED',
				errorCode: 'INVALID_FILTERS',
				attempts: 0,
			});
			expect(storage.uploadStream).not.toHaveBeenCalled();
			expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled();
		},
	);

	it('re-checks the persisted author membership before claiming any work', async () => {
		prisma.workspaceMember.findUnique.mockResolvedValue(null);
		await expect(processor.process(delivery)).rejects.toMatchObject({ code: 'MEMBERSHIP_REVOKED' });
		expect(prisma.workspaceMember.findUnique).toHaveBeenCalledWith({
			where: {
				userId_workspaceId: { userId: current.requestedById, workspaceId: current.workspaceId },
			},
		});
		expect(current).toMatchObject({ status: 'FAILED', attempts: 0, processingToken: null });
		expect(storage.uploadStream).not.toHaveBeenCalled();
	});

	it('completes an empty workspace as a downloadable header-only CSV', async () => {
		const chunks: Buffer[] = [];
		storage.uploadStream.mockImplementation(async ({ objectKey, body }) => {
			for await (const chunk of body) chunks.push(Buffer.from(chunk));
			objects.add(objectKey);
		});
		await processor.process(delivery);
		expect(Buffer.concat(chunks).toString('utf8')).toBe(
			'\uFEFFid,projectId,title,status,authorName,updatedAt\r\n',
		);
		expect(current).toMatchObject({ status: 'COMPLETED', progress: 100, attempts: 1 });
		expect(current.expiresAt!.getTime() - current.finishedAt!.getTime()).toBe(86_400_000);
	});

	it('preserves an uploaded CSV when the COMPLETED commit succeeds but its response is lost', async () => {
		const update = prisma.exportJob.updateMany.getMockImplementation()!;
		prisma.exportJob.updateMany.mockImplementation(async (args) => {
			const result = await update(args);
			if (args.data.status === 'COMPLETED') throw new Error('commit response lost');
			return result;
		});
		await expect(processor.process(delivery)).rejects.toBeInstanceOf(ExportDatabaseError);
		expect(current.status).toBe('COMPLETED');
		expect(objects.has(current.objectKey!)).toBe(true);
		expect(storage.remove).not.toHaveBeenCalled();
	});

	it('preserves the exact key for recovery when the COMPLETED write fails before commit', async () => {
		const update = prisma.exportJob.updateMany.getMockImplementation()!;
		prisma.exportJob.updateMany.mockImplementation(async (args) => {
			if (args.data.status === 'COMPLETED') throw new Error('DB disconnected');
			return update(args);
		});
		await expect(processor.process(delivery)).rejects.toBeInstanceOf(ExportDatabaseError);
		expect(current.status).toBe('PROCESSING');
		expect(objects.has(current.objectKey!)).toBe(true);
		expect(storage.remove).not.toHaveBeenCalled();
	});

	it('does not consume a processing attempt when the membership DB lookup fails', async () => {
		prisma.workspaceMember.findUnique.mockRejectedValue(new Error('DB unavailable'));
		await expect(processor.process(delivery)).rejects.toBeInstanceOf(ExportDatabaseError);
		expect(prisma.exportJob.updateMany).not.toHaveBeenCalled();
		expect(current).toMatchObject({ status: 'QUEUED', attempts: 0 });
		expect(storage.uploadStream).not.toHaveBeenCalled();
	});

	it('does not resolve a cancelled queued snapshot if its conditional transition loses a race', async () => {
		current.cancelRequestedAt = new Date();
		prisma.exportJob.updateMany.mockResolvedValue({ count: 0 });
		await expect(processor.process(delivery)).rejects.toBeInstanceOf(ExportLeaseLostError);
	});

	it('does not hide an in-flight heartbeat DB failure when the upload has just completed', async () => {
		let completeUpload!: () => void;
		let failHeartbeat: ((error: Error) => void) | undefined;
		let entered!: () => void;
		const heartbeatEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const uploadGate = new Promise<void>((resolve) => {
			completeUpload = resolve;
		});
		storage.uploadStream.mockImplementation(async ({ objectKey, body }) => {
			for await (const chunk of body) expect(chunk.length).toBeGreaterThan(0);
			await uploadGate;
			objects.add(objectKey);
		});
		const update = prisma.exportJob.updateMany.getMockImplementation()!;
		prisma.exportJob.updateMany.mockImplementation((args) => {
			if (args.data.heartbeatAt && !args.data.status)
				return new Promise((_resolve, reject) => {
					failHeartbeat = reject;
					entered();
				});
			return update(args);
		});
		const processing = processor.process(delivery).catch((error: unknown) => error);
		try {
			await heartbeatEntered;
			expect(failHeartbeat).toBeDefined();
			completeUpload();
			await new Promise(setImmediate);
			failHeartbeat!(new Error('heartbeat response lost'));
			expect(await processing).toBeInstanceOf(ExportDatabaseError);
			expect(current.status).toBe('PROCESSING');
			expect(objects.has(current.objectKey!)).toBe(true);
			expect(storage.remove).not.toHaveBeenCalled();
		} finally {
			completeUpload();
			failHeartbeat?.(new Error('test cleanup'));
			await processing.catch(() => {});
		}
	});
});
