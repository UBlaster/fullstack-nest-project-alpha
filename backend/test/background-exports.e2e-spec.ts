import { Readable } from 'node:stream';
import * as crypto from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ExportJobStatus, OutboxEventType, WorkspaceRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { ExportMaintenanceService } from '../src/worker/export-maintenance.service';
import { ExportProcessorService } from '../src/worker/export-processor.service';
import { DocumentsExportService } from '../src/documents/documents-export.service';
import { ExportsService } from '../src/exports/exports.service';
import { OutboxDispatcherService } from '../src/outbox/outbox-dispatcher.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ExportDeadLetterPayload, ExportQueuePayload } from '../src/queue/queue.constants';
import { QueueService } from '../src/queue/queue.service';
import {
	OBJECT_STORAGE,
	ObjectStorageService,
	S3_CLIENT,
	STORAGE_CONFIG,
} from '../src/storage/storage.tokens';
import { createAppValidationPipe } from '../src/validation.pipe';
import {
	createDeadLetterPayload,
	WorkerRuntimeService,
} from '../src/worker/worker-runtime.service';

const password = 'password123';
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const runId = `task6-e2e-${process.pid}-${Date.now()}`;
const ids = {
	workspace: `${runId}-workspace`,
	foreignWorkspace: `${runId}-foreign-workspace`,
	project: `${runId}-project`,
	document: `${runId}-document`,
};
const emails = {
	owner: `${runId}-owner@example.com`,
	member: `${runId}-member@example.com`,
	viewer: `${runId}-viewer@example.com`,
	outsider: `${runId}-outsider@example.com`,
	foreignOwner: `${runId}-foreign-owner@example.com`,
};

class FakeQueueService {
	readonly exportCalls: Array<{ payload: ExportQueuePayload; queueJobId: string }> = [];
	readonly deadLetters: ExportDeadLetterPayload[] = [];
	failNext = false;
	private blocked?: { promise: Promise<void>; release: () => void };

	blockNext() {
		let release: () => void = () => {};
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.blocked = { promise, release };
		return release;
	}

	async addExport(payload: ExportQueuePayload, queueJobId: string) {
		this.exportCalls.push({ payload, queueJobId });
		if (this.failNext) {
			this.failNext = false;
			throw new Error('temporary queue failure');
		}
		const blocked = this.blocked;
		this.blocked = undefined;
		if (blocked) await blocked.promise;
		return { id: queueJobId };
	}

	async addDeadLetter(payload: ExportDeadLetterPayload) {
		this.deadLetters.push(payload);
		return { id: `dead-${payload.sourceQueueJobId}` };
	}
}

class FakeStorage implements ObjectStorageService {
	readonly objects = new Map<string, Buffer>();
	readonly uploadKeys: string[] = [];
	readonly removedKeys: string[] = [];
	failNextUpload = false;
	failNextRemove = false;
	private uploadGate?: { promise: Promise<void>; release: () => void };
	uploadAtGate = deferred();

	holdNextUpload() {
		this.uploadAtGate = deferred();
		let release: () => void = () => {};
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.uploadGate = { promise, release };
		return release;
	}

	createUploadUrl() {
		return Promise.resolve('https://example.invalid/upload');
	}

	createDownloadUrl(input: { objectKey: string }) {
		return Promise.resolve(
			`https://example.invalid/download/${encodeURIComponent(input.objectKey)}`,
		);
	}

	async uploadStream(input: {
		objectKey: string;
		body: Readable;
		signal: AbortSignal;
	}): Promise<void> {
		this.uploadKeys.push(input.objectKey);
		if (this.failNextUpload) {
			this.failNextUpload = false;
			throw new Error('temporary storage failure');
		}
		const chunks: Buffer[] = [];
		for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
		const gate = this.uploadGate;
		this.uploadGate = undefined;
		if (gate) {
			this.uploadAtGate.resolve();
			let abort: (() => void) | undefined;
			const aborted = new Promise<never>((_resolve, reject) => {
				abort = () => reject(new Error('AbortError'));
				input.signal.addEventListener('abort', abort, { once: true });
			});
			try {
				await Promise.race([gate.promise, aborted]);
			} finally {
				if (abort) input.signal.removeEventListener('abort', abort);
			}
		}
		if (input.signal.aborted) throw new Error('AbortError');
		this.objects.set(input.objectKey, Buffer.concat(chunks));
	}

	head(objectKey: string) {
		const object = this.objects.get(objectKey);
		if (!object) throw new Error('NotFound');
		return Promise.resolve({ size: object.length, contentType: 'text/csv' });
	}

	remove(objectKey: string) {
		this.removedKeys.push(objectKey);
		if (this.failNextRemove) {
			this.failNextRemove = false;
			return Promise.reject(new Error('temporary cleanup failure'));
		}
		this.objects.delete(objectKey);
		return Promise.resolve();
	}

	async *list(): AsyncIterable<string> {
		for (const key of this.objects.keys()) yield key;
	}
}

describe('Task 6 background exports (e2e)', () => {
	let app: INestApplication;
	let prisma: PrismaService;
	let exportsService: ExportsService;
	let processor: ExportProcessorService;
	let maintenance: ExportMaintenanceService;
	let dispatcher: OutboxDispatcherService;
	let queue: FakeQueueService;
	let storage: FakeStorage;
	let ownerId: string;
	let memberId: string;
	let viewerId: string;
	let ownerToken: string;
	let memberToken: string;
	let viewerToken: string;
	let outsiderToken: string;
	const exportIds = new Set<string>();
	const originalHeartbeat = process.env.EXPORT_HEARTBEAT_THROTTLE_MS;
	afterEach(() => jest.restoreAllMocks());

	const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
	const until = async (check: () => Promise<boolean>) => {
		const deadline = Date.now() + 5000;
		while (!(await check())) {
			if (Date.now() >= deadline) throw new Error('Timed out waiting for queue state');
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	};
	const withRealQueue = async (
		name: string,
		run: (context: {
			queues: QueueService;
			config: ConfigService;
			runtime: WorkerRuntimeService;
			inspect: Queue<ExportQueuePayload>;
			dead: Queue;
		}) => Promise<void>,
	) => {
		const config = new ConfigService();
		const queueName = `${runId}-${name}`;
		const values: Record<string, string> = {
			REDIS_URL: process.env.REDIS_URL!,
			EXPORT_QUEUE_NAME: queueName,
			EXPORT_DLQ_NAME: `${queueName}-dead`,
		};
		jest.spyOn(config, 'get').mockImplementation((key: string) => values[key]);
		const connection = new Redis(values.REDIS_URL, { maxRetriesPerRequest: 1 });
		const inspect = new Queue<ExportQueuePayload>(queueName, { connection });
		const dead = new Queue(`${queueName}-dead`, { connection });
		const queues = new QueueService(config);
		const isolatedMaintenance = new ExportMaintenanceService(prisma, storage, config);
		jest.spyOn(isolatedMaintenance, 'start').mockImplementation(() => {});
		const runtime = new WorkerRuntimeService(
			config,
			processor,
			isolatedMaintenance,
			prisma,
			queues,
		);
		try {
			await run({ queues, config, runtime, inspect, dead });
		} finally {
			await runtime.close();
			// Each queue name belongs exclusively to this run; remove exact IDs only.
			for (const fixtureQueue of [inspect, dead]) {
				const jobs = await fixtureQueue.getJobs([
					'wait',
					'active',
					'delayed',
					'completed',
					'failed',
				]);
				expect(jobs.length).toBeLessThanOrEqual(2);
				for (const job of jobs) await job.remove();
			}
			await queues.onModuleDestroy();
			await Promise.all([inspect.close(), dead.close()]);
			await connection.quit();
		}
	};
	const queueJob = (exportJobId: string, attemptsMade = 0) =>
		({
			data: { exportJobId, schemaVersion: 1 },
			attemptsMade,
			opts: { attempts: 5 },
		}) as Job<ExportQueuePayload>;

	const login = async (email: string) => {
		const response = await request(app.getHttpServer())
			.post('/auth/login')
			.send({ email, password })
			.expect(200);
		return response.body.accessToken as string;
	};

	const createDirectJob = async (
		name: string,
		requestedById = ownerId,
		data: Partial<{
			status: ExportJobStatus;
			attempts: number;
			processingToken: string;
			heartbeatAt: Date;
			objectKey: string;
			expiresAt: Date;
			cancelRequestedAt: Date;
		}> = {},
	) => {
		const id = `${runId}-${name}`;
		exportIds.add(id);
		return prisma.exportJob.create({
			data: {
				id,
				workspaceId: ids.workspace,
				requestedById,
				filters: { schemaVersion: 1 },
				queueJobId: `export-${id}`,
				...data,
			},
		});
	};

	beforeAll(async () => {
		process.env.EXPORT_HEARTBEAT_THROTTLE_MS = '25';
		queue = new FakeQueueService();
		storage = new FakeStorage();
		const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(QueueService)
			.useValue(queue)
			.overrideProvider(S3_CLIENT)
			.useValue({ destroy: () => {} })
			.overrideProvider(STORAGE_CONFIG)
			.useValue({ bucket: 'task6-test', uploadTtlSeconds: 600, downloadTtlSeconds: 300 })
			.overrideProvider(OBJECT_STORAGE)
			.useValue(storage)
			.compile();
		app = moduleFixture.createNestApplication();
		app.useGlobalPipes(createAppValidationPipe());
		// Prevent the real timer from dispatching unrelated DB rows during setup.
		jest
			.spyOn(moduleFixture.get(OutboxDispatcherService), 'onModuleInit')
			.mockImplementation(() => {});
		await app.init();
		prisma = app.get(PrismaService);
		exportsService = app.get(ExportsService);
		const config = app.get(ConfigService);
		processor = new ExportProcessorService(
			prisma,
			app.get(DocumentsExportService),
			storage,
			config,
		);
		maintenance = new ExportMaintenanceService(prisma, storage, config);
		dispatcher = app.get(OutboxDispatcherService);
		dispatcher.onModuleDestroy();

		const passwordHash = await bcrypt.hash(password, 4);
		const users = await Promise.all(
			Object.entries(emails).map(([role, email]) =>
				prisma.user.create({ data: { email, name: `Task 6 ${role}`, password: passwordHash } }),
			),
		);
		[ownerId, memberId, viewerId] = users.map((user) => user.id);
		await prisma.workspace.create({
			data: {
				id: ids.workspace,
				name: 'Task 6 workspace',
				members: {
					create: [
						{ userId: ownerId, role: WorkspaceRole.OWNER },
						{ userId: memberId, role: WorkspaceRole.MEMBER },
						{ userId: viewerId, role: WorkspaceRole.VIEWER },
					],
				},
				projects: {
					create: {
						id: ids.project,
						name: 'Task 6 project',
						createdById: ownerId,
						documents: {
							create: {
								id: ids.document,
								title: 'Comma, quote " and\nnewline',
								content: 'must-not-be-exported',
								authorId: ownerId,
							},
						},
					},
				},
			},
		});
		await prisma.workspace.create({
			data: {
				id: ids.foreignWorkspace,
				name: 'Task 6 foreign workspace',
				members: { create: { userId: users[4].id, role: WorkspaceRole.OWNER } },
			},
		});
		[ownerToken, memberToken, viewerToken, outsiderToken] = await Promise.all([
			login(emails.owner),
			login(emails.member),
			login(emails.viewer),
			login(emails.outsider),
		]);
	});

	afterAll(async () => {
		const exactIds = [...exportIds];
		if (prisma) {
			const [jobs, events] = await Promise.all([
				prisma.exportJob.count({ where: { id: { in: exactIds } } }),
				prisma.outboxEvent.count({ where: { aggregateId: { in: exactIds } } }),
			]);
			if (events > 0) {
				await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: exactIds } } });
			}
			if (jobs > 0) await prisma.exportJob.deleteMany({ where: { id: { in: exactIds } } });
			await prisma.workspace.deleteMany({
				where: { id: { in: [ids.workspace, ids.foreignWorkspace] } },
			});
			await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
		}
		if (app) await app.close();
		if (originalHeartbeat === undefined) delete process.env.EXPORT_HEARTBEAT_THROTTLE_MS;
		else process.env.EXPORT_HEARTBEAT_THROTTLE_MS = originalHeartbeat;
	});

	it('returns 202 quickly and atomically creates ExportJob plus OutboxEvent', async () => {
		await request(app.getHttpServer()).post(`/workspaces/${ids.workspace}/exports`).expect(401);
		const startedAt = Date.now();
		const response = await request(app.getHttpServer())
			.post(`/workspaces/${ids.workspace}/exports`)
			.set(auth(ownerToken))
			.send({})
			.expect(202);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(response.body).toMatchObject({ status: 'QUEUED', progress: 0 });
		expect(response.body).not.toHaveProperty('queueJobId');
		exportIds.add(response.body.id as string);
		const [job, event] = await Promise.all([
			prisma.exportJob.findUnique({ where: { id: response.body.id } }),
			prisma.outboxEvent.findUnique({
				where: {
					type_aggregateId: {
						type: OutboxEventType.EXPORT_REQUESTED,
						aggregateId: response.body.id,
					},
				},
			}),
		]);
		expect(job?.filters).toEqual({ schemaVersion: 1 });
		expect(event?.payload).toEqual({ exportJobId: response.body.id, schemaVersion: 1 });
		await prisma.outboxEvent.updateMany({
			where: { aggregateId: response.body.id },
			data: { publishedAt: new Date() },
		});
	});

	it('rolls back ExportJob when the matching outbox insert fails', async () => {
		const exportId = crypto.randomUUID();
		exportIds.add(exportId);
		await prisma.outboxEvent.create({
			data: {
				type: OutboxEventType.EXPORT_REQUESTED,
				aggregateId: exportId,
				payload: { exportJobId: exportId, schemaVersion: 1 },
			},
		});
		const randomUuid = jest.spyOn(crypto, 'randomUUID').mockReturnValue(exportId);
		try {
			await request(app.getHttpServer())
				.post(`/workspaces/${ids.workspace}/exports`)
				.set(auth(ownerToken))
				.send({})
				.expect(500);
		} finally {
			randomUuid.mockRestore();
		}
		expect(await prisma.exportJob.findUnique({ where: { id: exportId } })).toBeNull();
	});

	it.each([
		['OWNER', () => ownerToken],
		['MEMBER', () => memberToken],
		['VIEWER', () => viewerToken],
	])('allows %s to create and enforces author/OWNER status access', async (_role, token) => {
		const response = await request(app.getHttpServer())
			.post(`/workspaces/${ids.workspace}/exports`)
			.set(auth(token()))
			.send({})
			.expect(202);
		const exportId = response.body.id as string;
		exportIds.add(exportId);
		await request(app.getHttpServer()).get(`/exports/${exportId}`).set(auth(token())).expect(200);
		await request(app.getHttpServer())
			.get(`/exports/${exportId}`)
			.set(auth(ownerToken))
			.expect(200);
		if (token() !== ownerToken) {
			const otherRoleToken = token() === memberToken ? viewerToken : memberToken;
			await request(app.getHttpServer())
				.get(`/exports/${exportId}`)
				.set(auth(otherRoleToken))
				.expect(403);
			await request(app.getHttpServer())
				.delete(`/exports/${exportId}`)
				.set(auth(otherRoleToken))
				.expect(403);
		}
		await request(app.getHttpServer()).get(`/exports/${exportId}`).expect(401);
		await request(app.getHttpServer()).delete(`/exports/${exportId}`).expect(401);
		await request(app.getHttpServer())
			.delete(`/exports/${exportId}`)
			.set(auth(outsiderToken))
			.expect(404);
		await request(app.getHttpServer())
			.delete(`/exports/${exportId}`)
			.set(auth(token()))
			.expect(202);
		await request(app.getHttpServer())
			.delete(`/exports/${exportId}`)
			.set(auth(ownerToken))
			.expect(202);
		await prisma.outboxEvent.updateMany({
			where: { aggregateId: exportId },
			data: { publishedAt: new Date() },
		});
	});

	it('returns hidden 404 to outsiders and never exposes internal fields', async () => {
		const job = await createDirectJob('hidden-job');
		await request(app.getHttpServer())
			.get(`/exports/${job.id}`)
			.set(auth(outsiderToken))
			.expect(404);
		const response = await request(app.getHttpServer())
			.get(`/exports/${job.id}`)
			.set(auth(ownerToken))
			.expect(200);
		expect(response.body).not.toHaveProperty('objectKey');
		expect(response.body).not.toHaveProperty('queueJobId');
		expect(response.body).not.toHaveProperty('processingToken');
		expect(response.body.downloadUrl).toBeNull();
	});

	it('claims an export atomically for only one worker', async () => {
		const job = await createDirectJob('atomic-claim');
		const claims = await Promise.all([processor.claim(job), processor.claim(job)]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		await prisma.exportJob.update({
			where: { id: job.id },
			data: { status: ExportJobStatus.CANCELLED, processingToken: null, heartbeatAt: null },
		});
	});

	it('does not lose cancel when QUEUED is claimed between read and update', async () => {
		const job = await createDirectJob('cancel-claim-race');
		jest
			.spyOn(prisma.exportJob, 'findUnique')
			.mockImplementationOnce(
				() =>
					processor.claim(job).then(() => job) as ReturnType<typeof prisma.exportJob.findUnique>,
			);
		const cancelled = await exportsService.cancel(ownerId, job.id);
		expect(cancelled.status).toBe('PROCESSING');
		expect(cancelled.cancelRequestedAt).not.toBeNull();
	});

	it('never acknowledges a delivery while the DB job is still PROCESSING', async () => {
		const job = await createDirectJob('active-redelivery');
		await processor.claim(job);
		await expect(processor.process(queueJob(job.id))).rejects.toThrow();
	});

	it('uses the broker retry budget even when earlier deliveries failed before DB claim', async () => {
		const job = await createDirectJob('broker-budget');
		storage.failNextUpload = true;
		await expect(processor.process(queueJob(job.id, 4))).rejects.toThrow();
		const failed = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
		expect(failed.status).toBe('FAILED');
		expect(failed.errorCode).toBe('RETRIES_EXHAUSTED');
	});

	it('keeps the winning file when an old attempt loses its lease after upload', async () => {
		const job = await createDirectJob('winner-file');
		const entered = deferred();
		const release = deferred();
		const upload = jest.spyOn(storage, 'uploadStream').mockImplementationOnce(async (input) => {
			for await (const chunk of input.body) {
				expect(chunk.length).toBeGreaterThan(0);
			}
			entered.resolve();
			await release.promise;
			storage.objects.set(input.objectKey, Buffer.from('old attempt'));
		});
		const old = processor.process(queueJob(job.id)).catch((error: unknown) => error);
		try {
			await entered.promise;
			await prisma.exportJob.update({
				where: { id: job.id },
				data: {
					status: ExportJobStatus.QUEUED,
					processingToken: null,
					heartbeatAt: null,
				},
			});
			await processor.process(queueJob(job.id, 1));
			const winner = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
			expect(winner.status).toBe('COMPLETED');
			const winningBytes = storage.objects.get(winner.objectKey!);
			release.resolve();
			expect(await old).toBeInstanceOf(Error);
			expect(storage.objects.get(winner.objectKey!)).toEqual(winningBytes);
		} finally {
			release.resolve();
			await old;
			upload.mockRestore();
		}
	});

	it('waits for an in-flight upload to settle before cleaning a failed producer', async () => {
		const job = await createDirectJob('settle-before-cleanup');
		const entered = deferred();
		const release = deferred();
		const actualFind = prisma.exportJob.findUnique.bind(prisma.exportJob);
		jest.spyOn(prisma.exportJob, 'findUnique').mockImplementation((args) => {
			if (args.select)
				return entered.promise.then(() => {
					throw new Error('page check failed');
				}) as ReturnType<typeof prisma.exportJob.findUnique>;
			return actualFind(args);
		});
		jest.spyOn(storage, 'uploadStream').mockImplementationOnce(async (input) => {
			entered.resolve();
			await release.promise;
			storage.objects.set(input.objectKey, Buffer.from('late upload'));
		});
		const remove = jest.spyOn(storage, 'remove');
		let settled = false;
		const processing = processor.process(queueJob(job.id)).catch(() => {
			settled = true;
		});
		try {
			await entered.promise;
			await new Promise((resolve) => setTimeout(resolve, 60));
			expect(settled).toBe(false);
			expect(remove).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			await processing;
		}
	});

	it('re-checks membership in the worker and fails permanently before storage', async () => {
		const job = await createDirectJob('revoked-member', memberId);
		await prisma.workspaceMember.delete({
			where: { userId_workspaceId: { userId: memberId, workspaceId: ids.workspace } },
		});
		const uploadsBefore = storage.uploadKeys.length;
		await expect(processor.process(queueJob(job.id))).rejects.toThrow('MEMBERSHIP_REVOKED');
		const failed = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
		expect(failed).toMatchObject({
			status: ExportJobStatus.FAILED,
			errorCode: 'MEMBERSHIP_REVOKED',
		});
		expect(storage.uploadKeys).toHaveLength(uploadsBefore);
		await prisma.workspaceMember.create({
			data: { userId: memberId, workspaceId: ids.workspace, role: WorkspaceRole.MEMBER },
		});
	});

	it('streams the Task 5 CSV shape and stores the object before COMPLETED', async () => {
		const job = await createDirectJob('successful-stream');
		const release = storage.holdNextUpload();
		const processing = processor.process(queueJob(job.id));
		try {
			await storage.uploadAtGate.promise;
			const pending = await exportsService.get(ownerId, job.id);
			expect(pending.status).toBe('PROCESSING');
			expect(pending.downloadUrl).toBeNull();
		} finally {
			release();
			await processing;
		}
		const completed = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
		expect(completed).toMatchObject({ status: ExportJobStatus.COMPLETED, progress: 100 });
		expect(completed.objectKey).toMatch(
			new RegExp(`^workspaces/${ids.workspace}/exports/${job.id}/.+\\.csv$`),
		);
		const csv = storage.objects.get(completed.objectKey!)?.toString('utf8');
		expect(csv).toContain('\uFEFFid,projectId,title,status,authorName,updatedAt\r\n');
		expect(csv).toContain('"Comma, quote "" and\nnewline"');
		expect(csv).not.toContain('must-not-be-exported');
		const status = await request(app.getHttpServer())
			.get(`/exports/${job.id}`)
			.set(auth(ownerToken))
			.expect(200);
		expect(status.body.downloadUrl).toMatch(/^https:\/\/example\.invalid\/download\//);
	});

	it('streams more than 500 rows with keyset pages and never selects content', async () => {
		const documentIds = Array.from(
			{ length: 501 },
			(_value, index) => `${runId}-paged-document-${String(index).padStart(3, '0')}`,
		);
		await prisma.document.createMany({
			data: documentIds.map((id, index) => ({
				id,
				projectId: ids.project,
				authorId: ownerId,
				title: `Paged document ${index}`,
				content: `private content ${index}`,
			})),
		});
		const findMany = jest.spyOn(prisma.document, 'findMany');
		try {
			const job = await createDirectJob('keyset-501');
			await processor.process(queueJob(job.id));
			const pageQueries = findMany.mock.calls.map(([args]) => args);
			expect(pageQueries).toHaveLength(2);
			expect(pageQueries.every((query) => query?.take === 500)).toBe(true);
			expect(pageQueries[0]?.select).not.toHaveProperty('content');
			expect(pageQueries[1]?.where).toHaveProperty('id.gt');
			const completed = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
			const csv = storage.objects.get(completed.objectKey!)?.toString('utf8');
			expect(csv).not.toContain('private content');
			expect(csv).toContain('Paged document 500');
		} finally {
			findMany.mockRestore();
			await prisma.document.deleteMany({ where: { id: { in: documentIds } } });
		}
	});

	it('does not upload a second object for terminal duplicate delivery', async () => {
		const job = await createDirectJob('terminal-duplicate', ownerId, {
			status: ExportJobStatus.COMPLETED,
			objectKey: `workspaces/${ids.workspace}/exports/${runId}-terminal-duplicate.csv`,
			expiresAt: new Date(Date.now() + 60_000),
		});
		const uploadsBefore = storage.uploadKeys.length;
		await processor.process(queueJob(job.id));
		expect(storage.uploadKeys).toHaveLength(uploadsBefore);
	});

	it('leases an outbox event once across concurrent dispatchers', async () => {
		const job = await createDirectJob('dispatch-once');
		await prisma.outboxEvent.create({
			data: {
				type: OutboxEventType.EXPORT_REQUESTED,
				aggregateId: job.id,
				payload: { exportJobId: job.id, schemaVersion: 1 },
			},
		});
		const release = queue.blockNext();
		const first = dispatcher.publishPending();
		for (
			let attempt = 0;
			attempt < 20 && queue.exportCalls.at(-1)?.payload.exportJobId !== job.id;
			attempt += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const second = await dispatcher.publishPending();
		expect(second).toBe(0);
		release();
		expect(await first).toBe(1);
		expect(queue.exportCalls.filter((call) => call.payload.exportJobId === job.id)).toHaveLength(1);
		const event = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: job.id } });
		expect(event.publishedAt).not.toBeNull();
	});

	it('keeps a failed outbox publish pending and retries with the stable job ID', async () => {
		const job = await createDirectJob('dispatch-retry');
		await prisma.outboxEvent.create({
			data: {
				type: OutboxEventType.EXPORT_REQUESTED,
				aggregateId: job.id,
				payload: { exportJobId: job.id, schemaVersion: 1 },
			},
		});
		queue.failNext = true;
		expect(await dispatcher.publishPending()).toBe(0);
		const failed = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: job.id } });
		expect(failed).toMatchObject({ publishedAt: null, attempts: 1, claimToken: null });
		await prisma.outboxEvent.update({
			where: { id: failed.id },
			data: { availableAt: new Date(0) },
		});
		expect(await dispatcher.publishPending()).toBe(1);
		const calls = queue.exportCalls.filter((call) => call.payload.exportJobId === job.id);
		expect(calls).toHaveLength(2);
		expect(new Set(calls.map((call) => call.queueJobId))).toEqual(new Set([job.queueJobId]));
	});

	it('returns QUEUED before a transient retry and marks attempt five FAILED', async () => {
		const retry = await createDirectJob('transient-retry');
		storage.failNextUpload = true;
		await expect(processor.process(queueJob(retry.id))).rejects.toThrow(
			'temporary storage failure',
		);
		const queued = await prisma.exportJob.findUniqueOrThrow({ where: { id: retry.id } });
		expect(queued).toMatchObject({ status: ExportJobStatus.QUEUED, attempts: 1 });
		expect(queued.processingToken).toBeNull();

		const exhausted = await createDirectJob('retries-exhausted', ownerId, { attempts: 4 });
		storage.failNextUpload = true;
		await expect(processor.process(queueJob(exhausted.id, 4))).rejects.toThrow(
			'temporary storage failure',
		);
		const failed = await prisma.exportJob.findUniqueOrThrow({ where: { id: exhausted.id } });
		expect(failed).toMatchObject({
			status: ExportJobStatus.FAILED,
			attempts: 5,
			errorCode: 'RETRIES_EXHAUSTED',
		});
	});

	it('retries a transient membership lookup failure before claim', async () => {
		const retry = await createDirectJob('pre-claim-db-retry');
		const membershipLookup = jest
			.spyOn(prisma.workspaceMember, 'findUnique')
			.mockRejectedValueOnce(Object.assign(new Error('database unavailable'), { code: 'P1001' }));
		await expect(processor.process(queueJob(retry.id))).rejects.toThrow('database unavailable');
		membershipLookup.mockRestore();
		const queued = await prisma.exportJob.findUniqueOrThrow({ where: { id: retry.id } });
		expect(queued).toMatchObject({
			status: ExportJobStatus.QUEUED,
			attempts: 1,
			errorCode: 'DATABASE_UNAVAILABLE',
		});

		const exhausted = await createDirectJob('pre-claim-db-exhausted', ownerId, { attempts: 4 });
		const finalLookup = jest
			.spyOn(prisma.workspaceMember, 'findUnique')
			.mockRejectedValueOnce(Object.assign(new Error('database unavailable'), { code: 'P1001' }));
		await expect(processor.process(queueJob(exhausted.id, 4))).rejects.toThrow(
			'database unavailable',
		);
		finalLookup.mockRestore();
		const failed = await prisma.exportJob.findUniqueOrThrow({ where: { id: exhausted.id } });
		expect(failed).toMatchObject({
			status: ExportJobStatus.FAILED,
			attempts: 5,
			errorCode: 'RETRIES_EXHAUSTED',
		});
	});

	it('cancels active upload idempotently and leaves no exact object', async () => {
		const job = await createDirectJob('active-cancel');
		storage.holdNextUpload();
		const processing = processor.process(queueJob(job.id));
		await storage.uploadAtGate.promise;
		await exportsService.cancel(ownerId, job.id);
		await processing;
		const cancelled = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
		expect(cancelled.status).toBe(ExportJobStatus.CANCELLED);
		const key = storage.uploadKeys.at(-1)!;
		expect(storage.objects.has(key)).toBe(false);
		expect(storage.removedKeys).toContain(key);
		const repeated = await exportsService.cancel(ownerId, job.id);
		expect(repeated.status).toBe(ExportJobStatus.CANCELLED);
	});

	it('removes an uploaded object when the processing lease is lost', async () => {
		const job = await createDirectJob('lease-lost-cleanup');
		const releaseUpload = storage.holdNextUpload();
		const processing = processor.process(queueJob(job.id));
		let claimed: { status: ExportJobStatus } | undefined;
		for (let attempt = 0; attempt < 50; attempt += 1) {
			claimed = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
			if (claimed.status === ExportJobStatus.PROCESSING) break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(claimed?.status).toBe(ExportJobStatus.PROCESSING);
		await prisma.exportJob.update({
			where: { id: job.id },
			data: {
				status: ExportJobStatus.QUEUED,
				processingToken: null,
				heartbeatAt: null,
			},
		});
		releaseUpload();
		await expect(processing).rejects.toThrow('lease lost');
		const key = storage.uploadKeys.at(-1)!;
		expect(storage.removedKeys).toContain(key);
		expect(storage.objects.has(key)).toBe(false);
	});

	it('returns the DB job to QUEUED when exact-object cleanup fails', async () => {
		const job = await createDirectJob('cleanup-retry');
		storage.failNextUpload = true;
		storage.failNextRemove = true;
		await expect(processor.process(queueJob(job.id))).rejects.toThrow('temporary cleanup failure');
		const queued = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
		expect(queued).toMatchObject({
			status: ExportJobStatus.QUEUED,
			attempts: 1,
			errorCode: 'STORAGE_UNAVAILABLE',
			processingToken: null,
		});
		const abandonedKey = queued.objectKey!;
		storage.objects.set(abandonedKey, Buffer.from('abandoned attempt'));
		await processor.process(queueJob(job.id, 1));
		expect(storage.objects.has(abandonedKey)).toBe(false);
		const completed = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
		expect(completed.status).toBe('COMPLETED');
		expect(completed.objectKey).not.toBe(abandonedKey);
		expect(storage.objects.has(completed.objectKey!)).toBe(true);
	});

	it('retries terminal attempt cleanup without changing FAILED or touching completed files', async () => {
		const job = await createDirectJob('failed-cleanup');
		storage.failNextUpload = true;
		storage.failNextRemove = true;
		await expect(processor.process(queueJob(job.id, 4))).rejects.toThrow(
			'temporary cleanup failure',
		);
		const failed = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
		expect(failed.status).toBe('FAILED');
		storage.objects.set(failed.objectKey!, Buffer.from('failed attempt'));
		const unrelatedKeys = [...storage.objects.keys()].filter((key) => key !== failed.objectKey);
		await maintenance.removeFailedAttempts();
		expect(storage.objects.has(failed.objectKey!)).toBe(false);
		for (const key of unrelatedKeys) expect(storage.objects.has(key)).toBe(true);
		expect(await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
			status: 'FAILED',
			objectKey: null,
		});
	});

	it('does not overlap maintenance ticks and waits for them before shutdown', async () => {
		const release = deferred();
		const recover = jest.spyOn(maintenance, 'recoverStale').mockImplementation(async () => {
			await release.promise;
			return 0;
		});
		jest.spyOn(maintenance, 'removeExpired').mockResolvedValue(0);
		maintenance.start();
		maintenance.start();
		let stopped = false;
		const stopping = maintenance.stop().then(() => {
			stopped = true;
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(recover).toHaveBeenCalledTimes(1);
			expect(stopped).toBe(false);
		} finally {
			release.resolve();
			await stopping;
		}
	});

	it('recovers only stale processing leases and rejects the old token', async () => {
		const staleAt = new Date(Date.now() - 600_000);
		const stale = await createDirectJob('stale-processing', ownerId, {
			status: ExportJobStatus.PROCESSING,
			processingToken: 'old-token',
			heartbeatAt: staleAt,
		});
		const fresh = await createDirectJob('fresh-processing', ownerId, {
			status: ExportJobStatus.PROCESSING,
			processingToken: 'fresh-token',
			heartbeatAt: new Date(),
		});
		expect(await maintenance.recoverStale()).toBe(1);
		const [staleCurrent, freshCurrent] = await Promise.all([
			prisma.exportJob.findUniqueOrThrow({ where: { id: stale.id } }),
			prisma.exportJob.findUniqueOrThrow({ where: { id: fresh.id } }),
		]);
		expect(staleCurrent).toMatchObject({ status: ExportJobStatus.QUEUED, processingToken: null });
		expect(freshCurrent).toMatchObject({
			status: ExportJobStatus.PROCESSING,
			processingToken: 'fresh-token',
		});
		const oldWrite = await prisma.exportJob.updateMany({
			where: {
				id: stale.id,
				status: ExportJobStatus.PROCESSING,
				processingToken: 'old-token',
			},
			data: { status: ExportJobStatus.COMPLETED },
		});
		expect(oldWrite.count).toBe(0);
	});

	it('retention removes only the exact expired completed object', async () => {
		const expiredKey = `workspaces/${ids.workspace}/exports/${runId}-expired.csv`;
		const futureKey = `workspaces/${ids.workspace}/exports/${runId}-future.csv`;
		storage.objects.set(expiredKey, Buffer.from('expired'));
		storage.objects.set(futureKey, Buffer.from('future'));
		const expired = await createDirectJob('expired', ownerId, {
			status: ExportJobStatus.COMPLETED,
			objectKey: expiredKey,
			expiresAt: new Date(Date.now() - 1_000),
		});
		await createDirectJob('future', ownerId, {
			status: ExportJobStatus.COMPLETED,
			objectKey: futureKey,
			expiresAt: new Date(Date.now() + 60_000),
		});
		expect(await maintenance.removeExpired()).toBe(1);
		expect(storage.objects.has(expiredKey)).toBe(false);
		expect(storage.objects.has(futureKey)).toBe(true);
		const current = await prisma.exportJob.findUniqueOrThrow({ where: { id: expired.id } });
		expect(current.objectKey).toBeNull();
		expect(current.expiredAt).not.toBeNull();
	});

	it('download URL is absent before completion and after retention expiry', async () => {
		const queued = await createDirectJob('download-gate');
		const before = await exportsService.get(ownerId, queued.id);
		expect(before.downloadUrl).toBeNull();
		await prisma.exportJob.update({
			where: { id: queued.id },
			data: {
				status: ExportJobStatus.COMPLETED,
				objectKey: `workspaces/${ids.workspace}/exports/${queued.id}.csv`,
				expiresAt: new Date(Date.now() - 1),
			},
		});
		const expired = await exportsService.get(ownerId, queued.id);
		expect(expired.downloadUrl).toBeNull();
	});

	it('persists heartbeat while upload is pending, at most once per throttle interval', async () => {
		const job = await createDirectJob('real-heartbeat');
		const config = new ConfigService();
		jest
			.spyOn(config, 'get')
			.mockImplementation((name) => (name === 'EXPORT_HEARTBEAT_THROTTLE_MS' ? 2000 : undefined));
		const slowProcessor = new ExportProcessorService(
			prisma,
			app.get(DocumentsExportService),
			storage,
			config,
		);
		const release = storage.holdNextUpload();
		const update = jest.spyOn(prisma.exportJob, 'updateMany');
		const processing = slowProcessor.process(queueJob(job.id));
		try {
			await storage.uploadAtGate.promise;
			await new Promise((resolve) => setTimeout(resolve, 2100));
			const heartbeats = update.mock.calls.filter(
				([args]) => args.data.progress !== undefined && args.data.heartbeatAt,
			);
			expect(heartbeats).toHaveLength(1);
			expect(heartbeats[0][0].where?.processingToken).toEqual(expect.any(String));
			const active = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
			expect(active.status).toBe('PROCESSING');
			expect(active.heartbeatAt!.getTime()).toBeGreaterThan(active.startedAt!.getTime());
		} finally {
			release();
			await processing;
		}
	});

	it('creates sanitized DLQ metadata', () => {
		const payload = createDeadLetterPayload('export-id', 'queue-id', 5, 'RETRIES_EXHAUSTED');
		expect(payload).toEqual({
			exportJobId: 'export-id',
			sourceQueueJobId: 'queue-id',
			attempts: 5,
			errorCode: 'RETRIES_EXHAUSTED',
		});
		expect(payload).not.toHaveProperty('message');
		expect(payload).not.toHaveProperty('stack');
		expect(payload).not.toHaveProperty('objectKey');
	});

	it('keeps queued jobs across producer restart, deduplicates IDs, and drains active work on close', async () => {
		await withRealQueue('restart', async ({ config, runtime, inspect }) => {
			const job = await createDirectJob('queue-restart');
			const producer = new QueueService(config);
			try {
				await producer.addExport({ exportJobId: job.id, schemaVersion: 1 }, job.queueJobId);
				await producer.addExport({ exportJobId: job.id, schemaVersion: 1 }, job.queueJobId);
			} finally {
				await producer.onModuleDestroy();
			}
			expect(await inspect.getWaitingCount()).toBe(1);
			const persisted = await inspect.getJob(job.queueJobId);
			expect(persisted?.opts).toMatchObject({
				attempts: 5,
				backoff: { type: 'exponential', delay: 5000 },
			});
			const release = storage.holdNextUpload();
			runtime.start();
			await storage.uploadAtGate.promise;
			let closed = false;
			const closing = runtime.close().then(() => {
				closed = true;
			});
			try {
				await new Promise((resolve) => setTimeout(resolve, 40));
				expect(closed).toBe(false);
				expect(await persisted!.getState()).toBe('active');
			} finally {
				release();
				await closing;
			}
			expect(await persisted!.getState()).toBe('completed');
			expect((await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
				'COMPLETED',
			);
		});
	});

	it('real BullMQ retries five times then publishes one sanitized DLQ job', async () => {
		await withRealQueue('retry-dlq', async ({ runtime, inspect, dead }) => {
			const job = await createDirectJob('real-retry-dlq');
			const upload = jest
				.spyOn(storage, 'uploadStream')
				.mockRejectedValue(new Error('private S3 message'));
			await inspect.add(
				'build-export',
				{ exportJobId: job.id, schemaVersion: 1 },
				{ jobId: job.queueJobId, attempts: 5, backoff: { type: 'fixed', delay: 10 } },
			);
			runtime.start();
			await until(async () => !!(await dead.getJob(`dead-${job.queueJobId}`)));
			await runtime.close();
			expect(upload).toHaveBeenCalledTimes(5);
			expect(await inspect.getJob(job.queueJobId).then((value) => value!.getState())).toBe(
				'failed',
			);
			expect((await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
				'FAILED',
			);
			expect((await dead.getJob(`dead-${job.queueJobId}`))!.data).toEqual({
				exportJobId: job.id,
				sourceQueueJobId: job.queueJobId,
				attempts: 5,
				errorCode: 'RETRIES_EXHAUSTED',
			});
		});
	});

	it('delays a live DB lease without ACK or consuming a BullMQ attempt', async () => {
		await withRealQueue('lease-delay', async ({ queues, runtime, inspect }) => {
			const job = await createDirectJob('real-lease-delay');
			await processor.claim(job);
			const queued = await queues.addExport(
				{ exportJobId: job.id, schemaVersion: 1 },
				job.queueJobId,
			);
			runtime.start();
			await until(async () => (await queued.getState()) === 'delayed');
			await runtime.close();
			expect((await inspect.getJob(job.queueJobId))!.attemptsMade).toBe(0);
			expect((await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
				'PROCESSING',
			);
		});
	});

	it('reconciles an exhausted queue job when the final DB read failed before claim', async () => {
		await withRealQueue('read-failure', async ({ runtime, inspect, dead }) => {
			const job = await createDirectJob('real-read-failure');
			jest
				.spyOn(prisma.exportJob, 'findUnique')
				.mockRejectedValueOnce(new Error('temporary DB read failure'));
			await inspect.add(
				'build-export',
				{ exportJobId: job.id, schemaVersion: 1 },
				{ jobId: job.queueJobId, attempts: 1 },
			);
			runtime.start();
			await until(async () => !!(await dead.getJob(`dead-${job.queueJobId}`)));
			expect((await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
				'FAILED',
			);
		});
	}, 10000);

	it('repairs a missed DLQ publication from the retained failed queue job idempotently', async () => {
		await withRealQueue('dlq-repair', async ({ queues, runtime, inspect, dead }) => {
			const job = await createDirectJob('real-dlq-repair');
			jest.spyOn(storage, 'uploadStream').mockRejectedValue(new Error('private storage detail'));
			const publish = jest
				.spyOn(queues, 'addDeadLetter')
				.mockRejectedValueOnce(new Error('temporary Redis failure'));
			const queued = await inspect.add(
				'build-export',
				{ exportJobId: job.id, schemaVersion: 1 },
				{ jobId: job.queueJobId, attempts: 1 },
			);
			runtime.start();
			await until(
				async () => (await queued.getState()) === 'failed' && publish.mock.calls.length > 0,
			);
			await runtime.close();
			await runtime.reconcileFailed();
			await runtime.reconcileFailed();
			expect(await dead.getWaitingCount()).toBe(1);
			expect((await dead.getJob(`dead-${job.queueJobId}`))!.data.errorCode).toBe(
				'RETRIES_EXHAUSTED',
			);
		});
	});
});
