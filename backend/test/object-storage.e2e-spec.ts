import { EventEmitter } from 'node:events';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentStatus, WorkspaceRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { Request, Response } from 'express';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { DocumentFilesService } from '../src/document-files/document-files.service';
import {
	DocumentsExportService,
	exportBatchSize,
	writeCsvChunk,
} from '../src/documents/documents-export.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { contentDisposition } from '../src/storage/s3-object-storage.service';
import { OBJECT_STORAGE, ObjectStorageService } from '../src/storage/storage.tokens';
import { createAppValidationPipe } from '../src/validation.pipe';

const password = 'password123';
const runId = `task5-e2e-${process.pid}-${Date.now()}`;
const ids = {
	workspace: `${runId}-workspace`,
	foreignWorkspace: `${runId}-foreign-workspace`,
	project: `${runId}-project`,
	foreignProject: `${runId}-foreign-project`,
	document: `${runId}-document`,
	foreignDocument: `${runId}-foreign-document`,
};
const emails = {
	owner: `${runId}-owner@example.com`,
	member: `${runId}-member@example.com`,
	viewer: `${runId}-viewer@example.com`,
	outsider: `${runId}-outsider@example.com`,
	foreignOwner: `${runId}-foreign-owner@example.com`,
};

interface UploadResponse {
	file: {
		id: string;
		documentId: string;
		originalName: string;
		mimeType: string;
		size: number;
		status: string;
		objectKey?: string;
	};
	uploadUrl: string;
	expiresInSeconds: number;
}

interface PendingFileCleanup {
	documentId: string;
	objectKey: string;
}

describe('Task 5 object storage and streaming export (e2e)', () => {
	let app: INestApplication;
	let prisma: PrismaService;
	let documentFiles: DocumentFilesService;
	let documentsExport: DocumentsExportService;
	let storage: ObjectStorageService;
	let ownerToken: string;
	let memberToken: string;
	let viewerToken: string;
	let outsiderToken: string;
	let foreignOwnerToken: string;
	let ownerId: string;
	const pendingFileCleanup = new Map<string, PendingFileCleanup>();
	const pendingOrphanCleanup = new Set<string>();

	const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
	const uploadPath = (documentId = ids.document) => `/documents/${documentId}/files/upload-url`;
	const completePath = (documentId: string, fileId: string) =>
		`/documents/${documentId}/files/${fileId}/complete`;
	const downloadPath = (documentId: string, fileId: string) =>
		`/documents/${documentId}/files/${fileId}/download-url`;
	const deletePath = (documentId: string, fileId: string) =>
		`/documents/${documentId}/files/${fileId}`;
	const exportPath = (workspaceId = ids.workspace) =>
		`/workspaces/${workspaceId}/documents/export.csv`;

	const login = async (email: string) => {
		const response = await request(app.getHttpServer())
			.post('/auth/login')
			.send({ email, password })
			.expect(200);
		return response.body.accessToken as string;
	};

	const requestUpload = (
		token: string,
		body: { fileName: string; mimeType: string; size: number },
		documentId = ids.document,
	) => request(app.getHttpServer()).post(uploadPath(documentId)).set(auth(token)).send(body);

	const createUpload = async (
		token: string,
		bytes: Uint8Array,
		fileName = 'notes.txt',
		mimeType = 'text/plain',
		documentId = ids.document,
	) => {
		const response = await requestUpload(
			token,
			{ fileName, mimeType, size: bytes.byteLength },
			documentId,
		).expect(201);
		const body = response.body as UploadResponse;
		const storedFile = await prisma.documentFile.findUniqueOrThrow({
			where: { id: body.file.id },
			select: { documentId: true, objectKey: true },
		});
		pendingFileCleanup.set(body.file.id, storedFile);
		expect(body.file).toMatchObject({
			documentId,
			originalName: fileName,
			mimeType,
			size: bytes.byteLength,
			status: 'PENDING',
		});
		expect(body.file.objectKey).toBeUndefined();
		expect(body.expiresInSeconds).toBe(600);
		const uploadUrl = new URL(body.uploadUrl);
		expect(uploadUrl.searchParams.get('X-Amz-Expires')).toBe('600');
		expect(uploadUrl.hostname).toBe(
			`${process.env.S3_BUCKET}.${new URL(process.env.S3_ENDPOINT!).hostname}`,
		);
		return body;
	};

	const put = async (upload: UploadResponse, bytes: Uint8Array, mimeType: string) => {
		const response = await fetch(upload.uploadUrl, {
			method: 'PUT',
			headers: { 'content-type': mimeType, origin: 'http://localhost:5173' },
			body: Buffer.from(bytes),
		});
		expect(response.status).toBe(200);
		return response;
	};

	const removeFile = async (token: string, documentId: string, fileId: string) => {
		await request(app.getHttpServer())
			.delete(deletePath(documentId, fileId))
			.set(auth(token))
			.expect(204);
		pendingFileCleanup.delete(fileId);
	};

	beforeAll(async () => {
		const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
		app = moduleFixture.createNestApplication();
		app.useGlobalPipes(createAppValidationPipe());
		await app.init();
		prisma = app.get(PrismaService);
		documentFiles = app.get(DocumentFilesService);
		documentsExport = app.get(DocumentsExportService);
		storage = app.get(OBJECT_STORAGE);

		const passwordHash = await bcrypt.hash(password, 4);
		const [owner, member, viewer, , foreignOwner] = await Promise.all(
			Object.entries(emails).map(([role, email]) =>
				prisma.user.create({
					data: { email, name: `Task 5 ${role}`, password: passwordHash },
				}),
			),
		);
		ownerId = owner.id;
		await prisma.workspace.create({
			data: {
				id: ids.workspace,
				name: 'Task 5 Workspace',
				members: {
					create: [
						{ userId: owner.id, role: WorkspaceRole.OWNER },
						{ userId: member.id, role: WorkspaceRole.MEMBER },
						{ userId: viewer.id, role: WorkspaceRole.VIEWER },
					],
				},
				projects: {
					create: {
						id: ids.project,
						name: 'Task 5 Project',
						createdById: owner.id,
						documents: {
							create: {
								id: ids.document,
								title: 'Comma, quote " and\nnewline',
								content: 'task5-secret-content',
								authorId: owner.id,
							},
						},
					},
				},
			},
		});
		await prisma.workspace.create({
			data: {
				id: ids.foreignWorkspace,
				name: 'Task 5 Foreign Workspace',
				members: { create: { userId: foreignOwner.id, role: WorkspaceRole.OWNER } },
				projects: {
					create: {
						id: ids.foreignProject,
						name: 'Task 5 Foreign Project',
						createdById: foreignOwner.id,
						documents: {
							create: {
								id: ids.foreignDocument,
								title: 'Foreign task 5 document',
								content: 'foreign-secret-content',
								authorId: foreignOwner.id,
							},
						},
					},
				},
			},
		});

		[ownerToken, memberToken, viewerToken, outsiderToken, foreignOwnerToken] = await Promise.all([
			login(emails.owner),
			login(emails.member),
			login(emails.viewer),
			login(emails.outsider),
			login(emails.foreignOwner),
		]);
	});

	afterAll(async () => {
		const cleanupErrors: unknown[] = [];
		try {
			if (storage && prisma) {
				for (const [fileId, file] of pendingFileCleanup) {
					try {
						await storage.remove(file.objectKey);
						await prisma.documentFile.deleteMany({
							where: {
								id: fileId,
								documentId: file.documentId,
								objectKey: file.objectKey,
							},
						});
					} catch (error) {
						cleanupErrors.push(error);
					}
				}
				for (const objectKey of pendingOrphanCleanup) {
					try {
						await storage.remove(objectKey);
					} catch (error) {
						cleanupErrors.push(error);
					}
				}
			}
			if (prisma) {
				try {
					await prisma.workspace.deleteMany({
						where: { id: { in: [ids.workspace, ids.foreignWorkspace] } },
					});
				} catch (error) {
					cleanupErrors.push(error);
				}
				try {
					await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
		} finally {
			if (app) await app.close();
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, 'Task 5 exact-fixture teardown failed');
		}
	});

	it('returns 401 before every storage or export operation', async () => {
		await request(app.getHttpServer()).get(`/documents/${ids.document}/files`).expect(401);
		await request(app.getHttpServer())
			.post(uploadPath())
			.send({ fileName: 'notes.txt', mimeType: 'text/plain', size: 3 })
			.expect(401);
		await request(app.getHttpServer()).post(completePath(ids.document, 'missing')).expect(401);
		await request(app.getHttpServer()).get(downloadPath(ids.document, 'missing')).expect(401);
		await request(app.getHttpServer()).delete(deletePath(ids.document, 'missing')).expect(401);
		await request(app.getHttpServer()).get(exportPath()).expect(401);
	});

	it('lists document file metadata for viewers and hides it from outsiders', async () => {
		await request(app.getHttpServer())
			.get(`/documents/${ids.document}/files`)
			.set(auth(viewerToken))
			.expect(200)
			.expect([]);
		await request(app.getHttpServer())
			.get(`/documents/${ids.document}/files`)
			.set(auth(outsiderToken))
			.expect(404);
	});

	it('exposes document capabilities without weakening hidden 404', async () => {
		await request(app.getHttpServer())
			.get(`/documents/${ids.document}/files/capabilities`)
			.expect(401);
		await request(app.getHttpServer())
			.get(`/documents/${ids.document}/files/capabilities`)
			.set(auth(ownerToken))
			.expect(200)
			.expect({ canUpdateDocument: true, canDeleteDocument: true, canManageFiles: true });
		await request(app.getHttpServer())
			.get(`/documents/${ids.document}/files/capabilities`)
			.set(auth(memberToken))
			.expect(200)
			.expect({ canUpdateDocument: true, canDeleteDocument: false, canManageFiles: true });
		await request(app.getHttpServer())
			.get(`/documents/${ids.document}/files/capabilities`)
			.set(auth(viewerToken))
			.expect(200)
			.expect({ canUpdateDocument: false, canDeleteDocument: false, canManageFiles: false });
		await request(app.getHttpServer())
			.get(`/documents/${ids.document}/files/capabilities`)
			.set(auth(outsiderToken))
			.expect(404);
	});

	it('lets OWNER upload directly, complete, download READY bytes and delete idempotently', async () => {
		const bytes = new TextEncoder().encode('task 5 owner bytes');
		const upload = await createUpload(ownerToken, bytes);
		const preflight = await fetch(upload.uploadUrl, {
			method: 'OPTIONS',
			headers: {
				origin: 'http://localhost:5173',
				'access-control-request-method': 'PUT',
				'access-control-request-headers': 'content-type',
			},
		});
		expect(preflight.ok).toBe(true);
		expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
		expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');
		expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
			'content-type',
		);
		await request(app.getHttpServer())
			.get(downloadPath(ids.document, upload.file.id))
			.set(auth(ownerToken))
			.expect(409);
		const uploaded = await put(upload, bytes, 'text/plain');
		expect(uploaded.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
		expect(uploaded.headers.get('access-control-expose-headers')?.toLowerCase()).toContain('etag');
		const anonymousObjectUrl = new URL(upload.uploadUrl);
		anonymousObjectUrl.search = '';
		expect((await fetch(anonymousObjectUrl)).status).toBe(403);
		const anonymousListUrl = new URL(upload.uploadUrl);
		anonymousListUrl.pathname = '/';
		anonymousListUrl.search = `?list-type=2&prefix=${encodeURIComponent(`workspaces/${ids.workspace}/`)}`;
		expect((await fetch(anonymousListUrl)).status).toBe(403);
		await request(app.getHttpServer())
			.post(completePath(ids.document, upload.file.id))
			.set(auth(ownerToken))
			.expect(200)
			.expect((response) => expect(response.body.status).toBe('READY'));
		const head = jest.spyOn(storage, 'head');
		try {
			await request(app.getHttpServer())
				.post(completePath(ids.document, upload.file.id))
				.set(auth(ownerToken))
				.expect(200)
				.expect((response) => expect(response.body.status).toBe('READY'));
			expect(head).not.toHaveBeenCalled();
		} finally {
			head.mockRestore();
		}
		const listed = await request(app.getHttpServer())
			.get(`/documents/${ids.document}/files`)
			.set(auth(viewerToken))
			.expect(200);
		expect(listed.body).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: upload.file.id, status: 'READY' })]),
		);
		expect(JSON.stringify(listed.body)).not.toMatch(/objectKey|bucket|Url/);

		const download = await request(app.getHttpServer())
			.get(downloadPath(ids.document, upload.file.id))
			.set(auth(viewerToken))
			.expect(200);
		expect(download.body.expiresInSeconds).toBe(300);
		expect(new URL(download.body.downloadUrl).searchParams.get('X-Amz-Expires')).toBe('300');
		const downloaded = await fetch(download.body.downloadUrl);
		expect(downloaded.status).toBe(200);
		expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);

		await removeFile(ownerToken, ids.document, upload.file.id);
		await request(app.getHttpServer())
			.delete(deletePath(ids.document, upload.file.id))
			.set(auth(ownerToken))
			.expect(204);
	});

	it('lets MEMBER upload/complete and denies VIEWER mutations', async () => {
		const bytes = new TextEncoder().encode('member bytes');
		const upload = await createUpload(memberToken, bytes, 'member.md', 'text/markdown');
		await put(upload, bytes, 'text/markdown');
		await request(app.getHttpServer())
			.post(completePath(ids.document, upload.file.id))
			.set(auth(memberToken))
			.expect(200);
		await request(app.getHttpServer())
			.get(downloadPath(ids.document, upload.file.id))
			.set(auth(memberToken))
			.expect(200);

		await requestUpload(viewerToken, {
			fileName: 'viewer.txt',
			mimeType: 'text/plain',
			size: 3,
		}).expect(403);
		await request(app.getHttpServer())
			.post(completePath(ids.document, upload.file.id))
			.set(auth(viewerToken))
			.expect(403);
		await request(app.getHttpServer())
			.delete(deletePath(ids.document, upload.file.id))
			.set(auth(viewerToken))
			.expect(403);
		await removeFile(memberToken, ids.document, upload.file.id);
	});

	it('returns hidden 404 without leaking URLs or object metadata', async () => {
		const response = await requestUpload(outsiderToken, {
			fileName: 'secret.txt',
			mimeType: 'text/plain',
			size: 3,
		}).expect(404);
		expect(JSON.stringify(response.body)).not.toMatch(/uploadUrl|objectKey|bucket/i);

		const foreign = await createUpload(
			foreignOwnerToken,
			new TextEncoder().encode('foreign'),
			'foreign.txt',
			'text/plain',
			ids.foreignDocument,
		);
		await put(foreign, new TextEncoder().encode('foreign'), 'text/plain');
		const foreignRecord = await prisma.documentFile.findUniqueOrThrow({
			where: { id: foreign.file.id },
		});
		for (const path of [
			completePath(ids.document, foreign.file.id),
			downloadPath(ids.document, foreign.file.id),
			deletePath(ids.document, foreign.file.id),
		]) {
			const method = path.endsWith('/complete')
				? 'post'
				: path.includes('download')
					? 'get'
					: 'delete';
			const cross = request(app.getHttpServer())[method](path).set(auth(ownerToken));
			await cross.expect(404).expect((result) => {
				expect(JSON.stringify(result.body)).not.toMatch(/Url|objectKey|bucket/i);
			});
		}
		await expect(storage.head(foreignRecord.objectKey)).resolves.toMatchObject({ size: 7 });
		await removeFile(foreignOwnerToken, ids.foreignDocument, foreign.file.id);
	});

	it.each([
		['string size', { fileName: 'payload.txt', mimeType: 'text/plain', size: '3' }, 400],
		['zero size', { fileName: 'payload.txt', mimeType: 'text/plain', size: 0 }, 400],
		[
			'unknown MIME',
			{ fileName: 'payload.bin', mimeType: 'application/octet-stream', size: 3 },
			415,
		],
		['extension mismatch', { fileName: 'payload.pdf', mimeType: 'text/plain', size: 3 }, 415],
		['forward-slash path', { fileName: '../payload.txt', mimeType: 'text/plain', size: 3 }, 400],
		['backslash path', { fileName: '..\\payload.txt', mimeType: 'text/plain', size: 3 }, 400],
		[
			'NFKC path separator',
			{ fileName: 'folder／payload.txt', mimeType: 'text/plain', size: 3 },
			400,
		],
		['too large', { fileName: 'payload.txt', mimeType: 'text/plain', size: 26_214_401 }, 400],
	])('rejects %s before issuing an upload URL', async (_label, body, status) => {
		const countBefore = await prisma.documentFile.count({
			where: { documentId: ids.document },
		});
		const createUploadUrl = jest.spyOn(storage, 'createUploadUrl');
		try {
			const response = await requestUpload(
				ownerToken,
				body as { fileName: string; mimeType: string; size: number },
			).expect(status);
			expect(response.body.uploadUrl).toBeUndefined();
			expect(await prisma.documentFile.count({ where: { documentId: ids.document } })).toBe(
				countBefore,
			);
			expect(createUploadUrl).not.toHaveBeenCalled();
		} finally {
			createUploadUrl.mockRestore();
		}
	});

	it('keeps PENDING when HEAD size or content type does not match', async () => {
		const expected = new TextEncoder().encode('expected');
		const missing = await createUpload(ownerToken, expected, 'missing.txt');
		await request(app.getHttpServer())
			.post(completePath(ids.document, missing.file.id))
			.set(auth(ownerToken))
			.expect(422);
		expect(
			await prisma.documentFile.findUniqueOrThrow({ where: { id: missing.file.id } }),
		).toMatchObject({
			status: 'PENDING',
		});
		const wrongSize = await createUpload(ownerToken, expected, 'wrong-size.txt');
		await put(wrongSize, new TextEncoder().encode('different length'), 'text/plain');
		await request(app.getHttpServer())
			.post(completePath(ids.document, wrongSize.file.id))
			.set(auth(ownerToken))
			.expect(422);
		expect(
			await prisma.documentFile.findUniqueOrThrow({ where: { id: wrongSize.file.id } }),
		).toMatchObject({ status: 'PENDING' });

		const wrongType = await createUpload(ownerToken, expected, 'wrong-type.txt');
		await put(wrongType, expected, 'text/csv');
		await request(app.getHttpServer())
			.post(completePath(ids.document, wrongType.file.id))
			.set(auth(ownerToken))
			.expect(422);
		expect(
			await prisma.documentFile.findUniqueOrThrow({ where: { id: wrongType.file.id } }),
		).toMatchObject({ status: 'PENDING' });
		await removeFile(ownerToken, ids.document, wrongSize.file.id);
		await removeFile(ownerToken, ids.document, wrongType.file.id);
		await removeFile(ownerToken, ids.document, missing.file.id);
	});

	it('treats an already missing object as an idempotent delete success', async () => {
		const upload = await createUpload(
			ownerToken,
			new TextEncoder().encode('not uploaded'),
			'missing-object.txt',
		);
		await removeFile(ownerToken, ids.document, upload.file.id);
		await request(app.getHttpServer())
			.delete(deletePath(ids.document, upload.file.id))
			.set(auth(ownerToken))
			.expect(204);
	});

	it('streams tenant-scoped CSV with the task 3 document card fields and escaping', async () => {
		for (const token of [ownerToken, memberToken]) {
			await request(app.getHttpServer()).get(exportPath()).set(auth(token)).expect(200);
		}
		const response = await request(app.getHttpServer())
			.get(exportPath())
			.set(auth(viewerToken))
			.buffer(true)
			.parse((res, callback) => {
				res.setEncoding('utf8');
				let body = '';
				res.on('data', (chunk: string) => (body += chunk));
				res.on('end', () => callback(null, body));
			})
			.expect(200)
			.expect('content-type', /text\/csv/);
		const csv = response.body as unknown as string;
		expect(csv).toContain('id,projectId,title,status,authorName,updatedAt');
		expect(csv).toContain('"Comma, quote "" and\nnewline"');
		expect(csv).not.toContain('task5-secret-content');
		expect(csv).not.toContain(ids.foreignDocument);
		expect(csv).not.toContain('foreign-secret-content');
		await request(app.getHttpServer())
			.get(exportPath(ids.foreignWorkspace))
			.set(auth(ownerToken))
			.expect(404);
	});

	it('cleans only explicitly scoped stale PENDING fixtures', async () => {
		const bytes = new TextEncoder().encode('cleanup');
		const stale = await createUpload(ownerToken, bytes, 'stale.txt');
		const fresh = await createUpload(ownerToken, bytes, 'fresh.txt');
		await put(stale, bytes, 'text/plain');
		await put(fresh, bytes, 'text/plain');
		const staleObjectKey = (
			await prisma.documentFile.findUniqueOrThrow({ where: { id: stale.file.id } })
		).objectKey;
		await prisma.documentFile.update({
			where: { id: stale.file.id },
			data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
		});

		await expect(
			documentFiles.cleanupStalePending(new Date(Date.now() - 24 * 60 * 60 * 1000), [
				stale.file.id,
				fresh.file.id,
			]),
		).resolves.toEqual({ removed: 1 });
		pendingFileCleanup.delete(stale.file.id);
		expect(await prisma.documentFile.findUnique({ where: { id: stale.file.id } })).toBeNull();
		await expect(storage.head(staleObjectKey)).rejects.toBeDefined();
		expect(await prisma.documentFile.findUnique({ where: { id: fresh.file.id } })).not.toBeNull();
		await expect(
			storage.head(
				(
					await prisma.documentFile.findUniqueOrThrow({
						where: { id: fresh.file.id },
					})
				).objectKey,
			),
		).resolves.toMatchObject({ size: bytes.byteLength });
		await removeFile(ownerToken, ids.document, fresh.file.id);
	});

	it('retries fresh cleanup records left DELETING by a storage failure', async () => {
		const fileId = `${runId}-cleanup-retry`;
		const objectKey = `workspaces/${ids.workspace}/documents/${ids.document}/${fileId}`;
		await prisma.documentFile.create({
			data: {
				id: fileId,
				documentId: ids.document,
				objectKey,
				originalName: 'cleanup-retry.txt',
				mimeType: 'text/plain',
				size: 1,
				status: 'DELETING',
			},
		});
		const remove = jest
			.spyOn(storage, 'remove')
			.mockRejectedValueOnce(new Error('temporary storage failure'))
			.mockResolvedValue(undefined);
		try {
			const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
			await expect(documentFiles.cleanupStalePending(cutoff, [fileId])).rejects.toThrow(
				'temporary storage failure',
			);
			expect(await prisma.documentFile.findUniqueOrThrow({ where: { id: fileId } })).toMatchObject({
				status: 'DELETING',
			});
			await expect(documentFiles.cleanupStalePending(cutoff, [fileId])).resolves.toEqual({
				removed: 1,
			});
			expect(remove).toHaveBeenCalledTimes(2);
		} finally {
			remove.mockRestore();
			await prisma.documentFile.deleteMany({ where: { id: fileId, objectKey } });
		}
	});

	it('does not delete a PENDING file that becomes READY after cleanup reads it', async () => {
		const bytes = new TextEncoder().encode('cleanup race');
		const upload = await createUpload(ownerToken, bytes, 'cleanup-race.txt');
		await put(upload, bytes, 'text/plain');
		await prisma.documentFile.update({
			where: { id: upload.file.id },
			data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
		});
		const staleRow = await prisma.documentFile.findUniqueOrThrow({
			where: { id: upload.file.id },
		});
		let releaseRead!: () => void;
		let markReadStarted!: () => void;
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const findMany = jest.spyOn(prisma.documentFile, 'findMany');
		findMany.mockReturnValueOnce(
			(async () => {
				markReadStarted();
				await release;
				return [staleRow];
			})() as never,
		);
		try {
			const cleanup = documentFiles.cleanupStalePending(
				new Date(Date.now() - 24 * 60 * 60 * 1000),
				[upload.file.id],
			);
			await readStarted;
			await documentFiles.complete(ownerId, ids.document, upload.file.id);
			releaseRead();
			await expect(cleanup).resolves.toEqual({ removed: 0 });
			expect(
				await prisma.documentFile.findUniqueOrThrow({ where: { id: upload.file.id } }),
			).toMatchObject({ status: 'READY' });
			await expect(storage.head(staleRow.objectKey)).resolves.toMatchObject({ size: bytes.length });
		} finally {
			releaseRead();
			findMany.mockRestore();
			await removeFile(ownerToken, ids.document, upload.file.id);
		}
	});

	it('encodes the extended download filename exactly as documented', () => {
		expect(contentDisposition("report (final)'*.pdf")).toBe(
			"attachment; filename=\"report (final)'*.pdf\"; filename*=UTF-8''report%20%28final%29%27%2A.pdf",
		);
	});

	it('keeps orphan-check dry-run by default and removes only on explicit apply', async () => {
		const objectKey = `workspaces/${ids.workspace}/documents/${ids.document}/${runId}-orphan`;
		pendingOrphanCleanup.add(objectKey);
		const uploadUrl = await storage.createUploadUrl({
			objectKey,
			mimeType: 'text/plain',
			expiresInSeconds: 60,
		});
		const uploaded = await fetch(uploadUrl, {
			method: 'PUT',
			headers: { 'content-type': 'text/plain' },
			body: Buffer.from('orphan'),
		});
		expect(uploaded.status).toBe(200);

		await expect(documentFiles.checkOrphans({ apply: false, prefix: objectKey })).resolves.toEqual({
			scanned: 1,
			orphans: 1,
			removed: 0,
		});
		await expect(storage.head(objectKey)).resolves.toMatchObject({ size: 6 });
		await expect(documentFiles.checkOrphans({ apply: true, prefix: objectKey })).resolves.toEqual({
			scanned: 1,
			orphans: 1,
			removed: 1,
		});
		await expect(storage.head(objectKey)).rejects.toBeDefined();
		pendingOrphanCleanup.delete(objectKey);
	});

	it.each(['workspaces/', '', 'other-prefix/'])(
		'rejects broad orphan apply prefix %j before listing storage',
		async (prefix) => {
			const list = jest.spyOn(storage, 'list').mockImplementation(() =>
				(async function* () {
					yield* [] as string[];
				})(),
			);
			try {
				await expect(documentFiles.checkOrphans({ apply: true, prefix })).rejects.toThrow(/prefix/);
				expect(list).not.toHaveBeenCalled();
			} finally {
				list.mockRestore();
			}
		},
	);

	it('rejects a dry-run prefix outside the object namespace before listing storage', async () => {
		const list = jest.spyOn(storage, 'list');
		try {
			await expect(
				documentFiles.checkOrphans({ apply: false, prefix: 'other-prefix/' }),
			).rejects.toThrow('object namespace');
			expect(list).not.toHaveBeenCalled();
		} finally {
			list.mockRestore();
		}
	});

	it('uses keyset pages of 500 without selecting content', async () => {
		const row = (index: number) => ({
			id: `row-${String(index).padStart(4, '0')}`,
			projectId: ids.project,
			title: `Row ${index}`,
			status: DocumentStatus.DRAFT,
			updatedAt: new Date('2026-09-05T00:00:00.000Z'),
			author: { name: 'Task 5 Owner' },
		});
		const firstPage = Array.from({ length: exportBatchSize }, (_, index) => row(index));
		const secondPage = [row(exportBatchSize)];
		const findMany = jest
			.spyOn(prisma.document, 'findMany')
			.mockResolvedValueOnce(firstPage as never)
			.mockResolvedValueOnce(secondPage as never);
		try {
			const received = [];
			for await (const item of documentsExport.iterateForExport(
				ids.workspace,
				new AbortController().signal,
			)) {
				received.push(item);
			}
			expect(received).toHaveLength(501);
			expect(findMany).toHaveBeenCalledTimes(2);
			expect(findMany.mock.calls[0][0]).toMatchObject({
				where: { project: { workspaceId: ids.workspace } },
				orderBy: { id: 'asc' },
				take: 500,
			});
			expect(findMany.mock.calls[0][0]?.select).not.toHaveProperty('content');
			expect(findMany.mock.calls[1][0]).toMatchObject({
				where: {
					project: { workspaceId: ids.workspace },
					id: { gt: firstPage[firstPage.length - 1].id },
				},
			});
		} finally {
			findMany.mockRestore();
		}
	});

	it('waits for drain when write returns false', async () => {
		const response = new EventEmitter() as EventEmitter & {
			destroyed: boolean;
			write: jest.Mock;
		};
		response.destroyed = false;
		response.write = jest.fn(() => false);
		let settled = false;
		const pending = writeCsvChunk(
			response as unknown as Response,
			'row\r\n',
			new AbortController().signal,
		).then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		response.emit('drain');
		await pending;
		expect(settled).toBe(true);
	});

	it('does not request another DB page after disconnect', async () => {
		const rows = Array.from({ length: exportBatchSize }, (_, index) => ({
			id: `disconnect-${index}`,
			projectId: ids.project,
			title: 'Disconnect',
			status: DocumentStatus.DRAFT,
			updatedAt: new Date(),
			author: { name: 'Task 5 Owner' },
		}));
		const findMany = jest.spyOn(prisma.document, 'findMany').mockResolvedValue(rows as never);
		const abortController = new AbortController();
		try {
			const iterator = documentsExport
				.iterateForExport(ids.workspace, abortController.signal)
				[Symbol.asyncIterator]();
			expect((await iterator.next()).done).toBe(false);
			abortController.abort();
			expect((await iterator.next()).done).toBe(true);
			expect(findMany).toHaveBeenCalledTimes(1);
		} finally {
			findMany.mockRestore();
		}
	});

	it('destroys and logs a CSV stream that fails after headers are sent', async () => {
		const requestStream = Object.assign(new EventEmitter(), {
			aborted: false,
			complete: true,
		});
		const responseStream = Object.assign(new EventEmitter(), {
			destroyed: false,
			headersSent: false,
			writableEnded: false,
			status: jest.fn(),
			setHeader: jest.fn(),
			write: jest.fn(),
			end: jest.fn(),
			destroy: jest.fn(),
		});
		responseStream.status.mockReturnValue(responseStream);
		responseStream.write.mockImplementation(() => {
			responseStream.headersSent = true;
			return true;
		});
		responseStream.destroy.mockImplementation(() => {
			responseStream.destroyed = true;
			return responseStream;
		});
		const streamError = new Error('late CSV failure');
		const failingRows: AsyncIterable<never> = {
			[Symbol.asyncIterator]: () => ({
				next: async () => Promise.reject(streamError),
			}),
		};
		const iterate = jest
			.spyOn(documentsExport, 'iterateForExport')
			.mockImplementation(() => failingRows);
		const logger = (
			documentsExport as unknown as {
				logger: { error: (message: string, stack?: string) => void };
			}
		).logger;
		const logError = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
		try {
			await documentsExport.export(
				ownerId,
				ids.workspace,
				requestStream as unknown as Request,
				responseStream as unknown as Response,
			);
			expect(responseStream.destroy).toHaveBeenCalledWith(streamError);
			expect(responseStream.end).not.toHaveBeenCalled();
			expect(logError).toHaveBeenCalledWith(
				'CSV export failed after the response started',
				streamError.stack,
			);
			expect(requestStream.listenerCount('aborted')).toBe(0);
			expect(requestStream.listenerCount('close')).toBe(0);
			expect(responseStream.listenerCount('close')).toBe(0);
		} finally {
			iterate.mockRestore();
			logError.mockRestore();
		}
	});
});
