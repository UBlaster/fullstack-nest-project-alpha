import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Channel } from 'amqplib';
import {
	HeadBucketCommand,
	HeadObjectCommand,
	ListMultipartUploadsCommand,
	S3Client,
} from '@aws-sdk/client-s3';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { OutboxDispatcherService } from '../src/outbox/outbox-dispatcher.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { QueueService } from '../src/queue/queue.service';
import { OBJECT_STORAGE, ObjectStorageService, S3_CLIENT } from '../src/storage/storage.tokens';
import { createAppValidationPipe } from '../src/validation.pipe';
import { ExportMaintenanceService } from '../src/worker/export-maintenance.service';
import { WorkerModule } from '../src/worker/worker.module';
import { WorkerRuntimeService } from '../src/worker/worker-runtime.service';
import { isolatedConfig } from './test-config';

const describeYandex = process.env.TASK6_YANDEX_E2E === 'true' ? describe : describe.skip;
const runId = `task6-yandex-e2e-${process.pid}-${Date.now()}`;
const workspaceId = `${runId}-workspace`;
const foreignWorkspaceId = `${runId}-foreign`;
const projectId = `${runId}-project`;
const otherProjectId = `${runId}-other-project`;
const ownerId = `${runId}-owner`;
const email = `${runId}@example.test`;
const rowCount = 40000;

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describeYandex('Task 6 real Yandex Object Storage acceptance', () => {
	let app: INestApplication;
	let worker: INestApplicationContext;
	let prisma: PrismaService;
	let runtime: WorkerRuntimeService;
	let storage: ObjectStorageService;
	let client: S3Client;
	let apiQueues: QueueService;
	let workerQueues: QueueService;
	let inspect: Channel;
	let token: string;
	let completedId: string;
	let uploads: jest.SpyInstance;
	const objectKeys = new Set<string>();
	const exportIds = new Set<string>();
	const commands = new Map<string, number>();
	const bucket = process.env.S3_BUCKET!;
	const until = async (check: () => Promise<boolean>, timeout = 120000) => {
		const deadline = Date.now() + timeout;
		while (!(await check())) {
			if (Date.now() >= deadline) throw new Error('Yandex acceptance state timed out');
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	};
	const createExport = async () => {
		const started = Date.now();
		const response = await request(app.getHttpServer())
			.post(`/workspaces/${workspaceId}/exports`)
			.set('Authorization', `Bearer ${token}`)
			.send({})
			.expect(202);
		exportIds.add(response.body.id as string);
		expect(Date.now() - started).toBeLessThan(1000);
		return response.body.id as string;
	};
	const status = (id: string) =>
		request(app.getHttpServer())
			.get(`/exports/${id}`)
			.set('Authorization', `Bearer ${token}`)
			.expect(200);
	const waitStatus = (id: string, expected: string, timeout?: number) =>
		until(
			async () => (await prisma.exportJob.findUniqueOrThrow({ where: { id } })).status === expected,
			timeout,
		);
	const noMultipart = async (id: string) => {
		const result = await client.send(
			new ListMultipartUploadsCommand({
				Bucket: bucket,
				Prefix: `workspaces/${workspaceId}/exports/${id}/`,
			}),
		);
		expect(result.Uploads ?? []).toHaveLength(0);
	};
	const missingObject = async (key: string) => {
		await expect(
			client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
		).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
	};

	beforeAll(async () => {
		const endpoint = new URL(process.env.S3_ENDPOINT!);
		if (
			endpoint.protocol !== 'https:' ||
			!(
				endpoint.hostname === 'storage.yandexcloud.net' ||
				endpoint.hostname.endsWith('.storage.yandexcloud.net')
			)
		)
			throw new Error('This acceptance suite requires the real Yandex HTTPS endpoint');
		if (!/(test|e2e)/i.test(new URL(process.env.DATABASE_URL!).pathname))
			throw new Error('A dedicated test database is required');
		const config = isolatedConfig({
			RABBITMQ_URL: process.env.RABBITMQ_URL,
			EXPORT_QUEUE_NAME: `${runId}-queue`,
			EXPORT_DLQ_NAME: `${runId}-dead`,
			EXPORT_RETRY_BACKOFF_MS: process.env.EXPORT_RETRY_BACKOFF_MS ?? '5000',
			EXPORT_LEASE_DELAY_MS: process.env.EXPORT_LEASE_DELAY_MS ?? '2000',
		});
		apiQueues = new QueueService(config);
		workerQueues = new QueueService(config);
		const apiModule = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(QueueService)
			.useValue(apiQueues)
			.compile();
		app = apiModule.createNestApplication();
		app.useGlobalPipes(createAppValidationPipe());
		await app.init();
		prisma = app.get(PrismaService);
		const workerModule = await Test.createTestingModule({ imports: [WorkerModule] })
			.overrideProvider(QueueService)
			.useValue(workerQueues)
			.compile();
		worker = workerModule;
		await worker.init();
		runtime = worker.get(WorkerRuntimeService);
		storage = worker.get<ObjectStorageService>(OBJECT_STORAGE);
		client = worker.get<S3Client>(S3_CLIENT);
		const head = await client.send(new HeadBucketCommand({ Bucket: bucket }));
		expect(head.$metadata.httpStatusCode).toBe(200);
		client.middlewareStack.add(
			(next, context) => async (args) => {
				const command = context.commandName ?? 'UnknownCommand';
				commands.set(command, (commands.get(command) ?? 0) + 1);
				return next(args);
			},
			{ step: 'initialize', name: 'yandexAcceptanceCommands' },
		);
		const realUpload = storage.uploadStream.bind(storage);
		uploads = jest.spyOn(storage, 'uploadStream').mockImplementation((input) => {
			objectKeys.add(input.objectKey);
			return realUpload(input);
		});
		inspect = await apiQueues.createConsumerChannel();
		const password = randomUUID();
		await prisma.user.create({
			data: {
				id: ownerId,
				email,
				name: 'Yandex acceptance owner',
				password: await bcrypt.hash(password, 4),
			},
		});
		await prisma.workspace.create({
			data: {
				id: workspaceId,
				name: 'Yandex cloud acceptance',
				members: { create: { userId: ownerId, role: 'OWNER' } },
				projects: {
					create: [
						{
							id: projectId,
							name: 'Small project',
							createdById: ownerId,
							documents: {
								create: {
									id: `${runId}-escaped`,
									title: 'Yandex, quote " and\nnewline',
									body: 'YALC-PRIVATE-CONTENT',
									authorId: ownerId,
								},
							},
						},
						{ id: otherProjectId, name: 'Large project', createdById: ownerId },
					],
				},
			},
		});
		await prisma.workspace.create({
			data: {
				id: foreignWorkspaceId,
				name: 'Foreign cloud fixture',
				projects: {
					create: {
						id: `${runId}-foreign-project`,
						name: 'Foreign project',
						createdById: ownerId,
						documents: {
							create: {
								id: `${runId}-foreign-document`,
								title: 'FOREIGN-YANDEX-DOCUMENT',
								body: 'FOREIGN-PRIVATE',
								authorId: ownerId,
							},
						},
					},
				},
			},
		});
		for (let offset = 0; offset < rowCount; offset += 1000) {
			await prisma.document.createMany({
				data: Array.from({ length: 1000 }, (_, index) => ({
					id: `${runId}-row-${String(offset + index).padStart(5, '0')}`,
					projectId: otherProjectId,
					authorId: ownerId,
					title: `Yandex row ${offset + index} ${'x'.repeat(60)}`,
					body: 'YALC-PRIVATE-BATCH',
					status: (['DRAFT', 'ACTIVE', 'ARCHIVED'] as const)[index % 3],
				})),
			});
		}
		const loggedIn = await request(app.getHttpServer())
			.post('/auth/login')
			.send({ email, password })
			.expect(200);
		token = loggedIn.body.accessToken as string;
	}, 120000);

	afterAll(async () => {
		const errors: unknown[] = [];
		try {
			await runtime?.close();
		} catch (error) {
			errors.push(error);
		}
		app?.get(OutboxDispatcherService).onModuleDestroy();
		if (storage)
			for (const key of objectKeys) {
				try {
					await storage.remove(key);
				} catch (error) {
					errors.push(error);
				}
			}
		if (apiQueues && inspect) {
			for (const name of [
				apiQueues.queueName,
				apiQueues.deadQueueName,
				apiQueues.leaseQueueName,
				...apiQueues.retryQueueNames,
			]) {
				try {
					await inspect.checkQueue(name);
					await inspect.deleteQueue(name);
				} catch (error) {
					errors.push(error);
				}
			}
			await inspect.close();
		}
		if (prisma && errors.length === 0) {
			await prisma.outboxEvent.count({ where: { aggregateId: { in: [...exportIds] } } });
			await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: [...exportIds] } } });
			await prisma.workspace.deleteMany({
				where: { id: { in: [workspaceId, foreignWorkspaceId] } },
			});
			await prisma.user.deleteMany({ where: { id: ownerId, email } });
		}
		for (const result of await Promise.allSettled([worker?.close(), app?.close()]))
			if (result.status === 'rejected') errors.push(result.reason);
		jest.restoreAllMocks();
		if (errors.length)
			throw new Error('Yandex fixture cleanup failed; retained database references');
	}, 120000);

	it('exports more than 5 MiB through real outbox/RabbitMQ/worker multipart and downloads from Yandex', async () => {
		completedId = await createExport();
		expect((await status(completedId)).body.downloadUrl).toBeNull();
		await until(async () => (await inspect.checkQueue(apiQueues.queueName)).messageCount === 1);
		runtime.start();
		await waitStatus(completedId, 'COMPLETED');
		const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: completedId } });
		const head = await storage.head(job.objectKey!);
		expect(head.size).toBeGreaterThan(5 * 1024 * 1024);
		expect(commands.get('CreateMultipartUploadCommand')).toBeGreaterThanOrEqual(1);
		expect(commands.get('UploadPartCommand')).toBeGreaterThanOrEqual(2);
		expect(commands.get('CompleteMultipartUploadCommand')).toBeGreaterThanOrEqual(1);
		const response = await status(completedId);
		const url = new URL(response.body.downloadUrl as string);
		expect(url.protocol).toBe('https:');
		expect(
			url.hostname.endsWith('.storage.yandexcloud.net') ||
				url.hostname === 'storage.yandexcloud.net',
		).toBe(true);
		expect(url.searchParams.has('X-Amz-Signature')).toBe(true);
		const downloaded = await fetch(url);
		expect(downloaded.status).toBe(200);
		const bytes = Buffer.from(await downloaded.arrayBuffer());
		expect(bytes.subarray(0, 3)).toEqual(Buffer.from([239, 187, 191]));
		const csv = bytes.toString('utf8');
		expect(csv).toContain('"Yandex, quote "" and\nnewline"');
		expect(csv).toContain(`${runId}-row-39999`);
		expect(csv).not.toMatch(/YALC-PRIVATE|FOREIGN-YANDEX|FOREIGN-PRIVATE/);
		await noMultipart(completedId);
	}, 180000);

	it('does not upload again when the same completed command is redelivered', async () => {
		const before = uploads.mock.calls.length;
		const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: completedId } });
		await apiQueues.addExport({ exportJobId: completedId, schemaVersion: 1 }, job.queueJobId);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(uploads.mock.calls).toHaveLength(before);
		expect(
			(await prisma.exportJob.findUniqueOrThrow({ where: { id: completedId } })).attempts,
		).toBe(1);
		await storage.head(job.objectKey!);
	});

	it('cancels a real in-flight Yandex multipart and removes its parts before CANCELLED', async () => {
		const entered = gate();
		const release = gate();
		let held = false;
		client.middlewareStack.add(
			(next, context) => async (args) => {
				const result = await next(args);
				if (context.commandName === 'UploadPartCommand' && !held) {
					held = true;
					entered.resolve();
					await release.promise;
				}
				return result;
			},
			{ step: 'initialize', name: 'holdYandexPart' },
		);
		let id: string | undefined;
		try {
			id = await createExport();
			await entered.promise;
			const job = await prisma.exportJob.findUniqueOrThrow({ where: { id } });
			await request(app.getHttpServer())
				.delete(`/exports/${id}`)
				.set('Authorization', `Bearer ${token}`)
				.expect(202);
			await until(async () =>
				uploads.mock.calls.some(
					([input]) => input.objectKey === job.objectKey && input.signal.aborted,
				),
			);
			expect((await prisma.exportJob.findUniqueOrThrow({ where: { id } })).status).toBe(
				'PROCESSING',
			);
			release.resolve();
			await waitStatus(id, 'CANCELLED');
			await missingObject(job.objectKey!);
			await noMultipart(id);
		} finally {
			release.resolve();
			client.middlewareStack.remove('holdYandexPart');
		}
	}, 180000);

	it('retries a controlled completion failure, aborts old Yandex parts and publishes one result', async () => {
		let failOnce = true;
		client.middlewareStack.add(
			(next, context) => async (args) => {
				if (context.commandName === 'CompleteMultipartUploadCommand' && failOnce) {
					failOnce = false;
					throw new Error('Injected cloud completion failure');
				}
				return next(args);
			},
			{ step: 'initialize', name: 'failYandexCompleteOnce' },
		);
		try {
			const id = await createExport();
			await waitStatus(id, 'COMPLETED');
			const job = await prisma.exportJob.findUniqueOrThrow({ where: { id } });
			expect(job.attempts).toBe(2);
			const attempts = uploads.mock.calls.filter(([input]) => input.objectKey.includes(`/${id}/`));
			expect(attempts).toHaveLength(2);
			expect(attempts[0][0].objectKey).not.toBe(job.objectKey);
			await missingObject(attempts[0][0].objectKey);
			await storage.head(job.objectKey!);
			await noMultipart(id);
		} finally {
			client.middlewareStack.remove('failYandexCompleteOnce');
		}
	}, 180000);

	it('fails on attempt five, confirms sanitized DLQ, and leaves no Yandex parts or CSV', async () => {
		client.middlewareStack.add(
			(next, context) => async (args) => {
				if (context.commandName === 'CompleteMultipartUploadCommand')
					throw new Error('Injected persistent cloud completion failure');
				return next(args);
			},
			{ step: 'initialize', name: 'failYandexCompleteAlways' },
		);
		try {
			const id = await createExport();
			await waitStatus(id, 'FAILED', 240000);
			await until(
				async () => (await inspect.checkQueue(apiQueues.deadQueueName)).messageCount === 1,
			);
			const job = await prisma.exportJob.findUniqueOrThrow({ where: { id } });
			expect(job).toMatchObject({ attempts: 5, errorCode: 'RETRIES_EXHAUSTED' });
			const dead = await inspect.get(apiQueues.deadQueueName, { noAck: false });
			if (!dead) throw new Error('Yandex failure did not reach DLQ');
			expect(JSON.parse(dead.content.toString())).toEqual({
				exportJobId: id,
				sourceQueueJobId: job.queueJobId,
				attempts: 5,
				errorCode: 'RETRIES_EXHAUSTED',
			});
			inspect.ack(dead);
			for (const [input] of uploads.mock.calls.filter(([input]) =>
				input.objectKey.includes(`/${id}/`),
			))
				await missingObject(input.objectKey);
			await noMultipart(id);
		} finally {
			client.middlewareStack.remove('failYandexCompleteAlways');
		}
	}, 300000);

	it('hides expired downloads and retention deletes only the recorded Yandex key', async () => {
		const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: completedId } });
		const protectedKey = `workspaces/${foreignWorkspaceId}/exports/${runId}/protected.csv`;
		objectKeys.add(protectedKey);
		await storage.uploadStream({
			objectKey: protectedKey,
			body: Readable.from(['keep']),
			contentType: 'text/csv',
			signal: new AbortController().signal,
		});
		await prisma.exportJob.update({
			where: { id: completedId },
			data: { expiresAt: new Date(Date.now() - 1000) },
		});
		expect((await status(completedId)).body.downloadUrl).toBeNull();
		expect(await worker.get(ExportMaintenanceService).removeExpired()).toBe(1);
		await missingObject(job.objectKey!);
		expect((await storage.head(protectedKey)).size).toBe(4);
	});
});
