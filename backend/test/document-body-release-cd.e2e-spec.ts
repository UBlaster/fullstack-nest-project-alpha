import { randomUUID } from 'node:crypto';
import { ExecutionContext, INestApplication, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaClient, WorkspaceRole } from '@prisma/client';
import * as request from 'supertest';
import { AccessPolicyService } from '../src/access/access-policy.service';
import { AuthenticatedRequest } from '../src/auth/authenticated-request';
import { JwtAuthGuard } from '../src/auth/decorators/jwt-auth.decorator';
import { CacheService } from '../src/cache/cache.service';
import { DocumentFilesController } from '../src/document-files/controllers/document-files.controller';
import { DocumentFilesService } from '../src/document-files/document-files.service';
import { DocumentsController } from '../src/documents/controllers/documents.controller';
import { ProjectDocumentsController } from '../src/documents/controllers/project-documents.controller';
import { DocumentsService } from '../src/documents/documents.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProjectsController } from '../src/projects/controllers/projects.controller';
import { ProjectsService } from '../src/projects/projects.service';
import { OBJECT_STORAGE, STORAGE_CONFIG, StorageConfig } from '../src/storage/storage.tokens';
import { createAppValidationPipe } from '../src/validation.pipe';
import { isolatedConfig } from './test-config';

const describeReleaseCD = process.env.TASK7_RELEASE_CD_E2E === 'true' ? describe : describe.skip;

function dedicatedDatabaseUrl(): string {
	const value = process.env.TASK7_RELEASE_CD_DATABASE_URL;
	if (!value) throw new Error('TASK7_RELEASE_CD_DATABASE_URL is required for this opt-in suite');
	let target: URL;
	try {
		target = new URL(value);
	} catch {
		throw new Error('Invalid C/D test database configuration');
	}
	if (
		!['postgres:', 'postgresql:'].includes(target.protocol) ||
		!['localhost', '127.0.0.1'].includes(target.hostname) ||
		target.port !== '55437' ||
		target.pathname !== '/task7_release_cd_test' ||
		(target.searchParams.get('schema') ?? 'public') !== 'public' ||
		target.searchParams.getAll('schema').length > 1 ||
		[...target.searchParams.keys()].some((key) => key !== 'schema')
	) {
		throw new Error('Only the dedicated local task7_release_cd_test database is allowed');
	}
	return value;
}

function queryClient(url: string) {
	return new PrismaClient({
		datasources: { db: { url } },
		log: [{ emit: 'event', level: 'query' }],
	});
}

function publicDocument(value: unknown, content: string): { id: string; content: string } {
	expect(value).toMatchObject({ id: expect.any(String), content });
	expect(value).not.toHaveProperty('body');
	return value as { id: string; content: string };
}

describeReleaseCD('Task 7 C/D HTTP compatibility and legacy-free document SQL', () => {
	const runId = `task7-release-cd-${randomUUID()}`;
	const ids = {
		owner: `${runId}-owner`,
		viewer: `${runId}-viewer`,
		outsider: `${runId}-outsider`,
		workspace: `${runId}-workspace`,
		foreignWorkspace: `${runId}-foreign-workspace`,
		project: `${runId}-project`,
		foreignProject: `${runId}-foreign-project`,
	};
	const users = new Map(
		[ids.owner, ids.viewer, ids.outsider].map((id) => [id, `${id}@example.test`]),
	);
	const cache = {
		invalidateWorkspace: jest.fn().mockResolvedValue(undefined),
		getWorkspaceVersion: jest.fn().mockResolvedValue(null),
	};
	const storage = {
		createUploadUrl: jest.fn().mockResolvedValue('https://example.test/upload'),
		createDownloadUrl: jest.fn().mockResolvedValue('https://example.test/download'),
		head: jest.fn().mockResolvedValue({ size: 7, contentType: 'text/plain', etag: 'fixture-etag' }),
		remove: jest.fn().mockResolvedValue(undefined),
	};
	const storageConfig: StorageConfig = {
		bucket: 'task7-cd-test',
		uploadTtlSeconds: 60,
		downloadTtlSeconds: 60,
	};
	let app: INestApplication;
	let prisma: ReturnType<typeof queryClient>;
	let error: jest.SpyInstance;
	let databaseVerified = false;
	let hasLegacy = false;
	let bodyNullable = true;
	let captureQueries = false;
	const queries: string[] = [];
	const auth = (userId = ids.owner) => ({ 'x-task7-user-id': userId });
	const fixtureDocument = async (body: string): Promise<{ id: string }> => {
		const [document] = await prisma.$queryRaw<Array<{ id: string }>>`
			INSERT INTO "Document" ("id", "projectId", "authorId", "title", "body", "updatedAt")
			VALUES (${randomUUID()}, ${ids.project}, ${ids.owner}, 'C/D fixture', ${body}, CURRENT_TIMESTAMP)
			RETURNING "id"
		`;
		return document;
	};
	const storedBody = async (id: string) => {
		const [document] = await prisma.$queryRaw<
			Array<{ title: string; body: string | null; updatedAt: Date }>
		>`SELECT "title", "body", "updatedAt" FROM "Document" WHERE "id" = ${id}`;
		if (!document) throw new Error('C/D fixture document was not found');
		return document;
	};
	const legacy = async (id: string): Promise<string | null | undefined> => {
		if (!hasLegacy) return undefined;
		const [row] = await prisma.$queryRaw<Array<{ content: string | null }>>`
			SELECT "content" FROM "Document" WHERE "id" = ${id}
		`;
		return row.content;
	};
	const setLegacy = async (id: string, value: string) => {
		if (hasLegacy)
			await prisma.$executeRaw`UPDATE "Document" SET "content" = ${value} WHERE "id" = ${id}`;
	};
	const captured = async <T>(work: () => Promise<T>): Promise<T> => {
		queries.length = 0;
		captureQueries = true;
		try {
			const result = await work();
			expect(queries.length).toBeGreaterThan(0);
			expect(queries.every((query) => !/\bcontent\b/i.test(query))).toBe(true);
			return result;
		} finally {
			captureQueries = false;
		}
	};
	const readPaths = async (id: string, expected: string) => {
		await captured(async () => {
			const fetched = await request(app.getHttpServer())
				.get(`/documents/${id}`)
				.set(auth())
				.expect(200);
			publicDocument(fetched.body, expected);
			expect(fetched.body).toMatchObject({
				author: { name: 'C/D test user' },
				project: { id: ids.project, workspaceId: ids.workspace },
			});
			const listed = await request(app.getHttpServer())
				.get(`/projects/${ids.project}/documents`)
				.set(auth())
				.expect(200);
			const rows = listed.body as Array<{ id: string }>;
			const listedDocument = rows.find((row) => row.id === id);
			publicDocument(listedDocument, expected);
			expect(listedDocument).toMatchObject({ author: { name: 'C/D test user' } });
			const project = await request(app.getHttpServer())
				.get(`/projects/${ids.project}`)
				.set(auth())
				.expect(200);
			const nestedRows = project.body.documents as Array<{ id: string }>;
			const nested = nestedRows.find((row) => row.id === id);
			publicDocument(nested, expected);
			expect(nested).toMatchObject({ author: { name: 'C/D test user' } });
		});
	};

	beforeAll(async () => {
		prisma = queryClient(dedicatedDatabaseUrl());
		prisma.$on('query', (event) => {
			// Параметры не сохраняются и не логируются; нужны только имена колонок в рабочем SQL.
			if (captureQueries && event.query.includes('"Document"')) queries.push(event.query);
		});
		await prisma.$connect();
		const [target] = await prisma.$queryRaw<Array<{ database: string; schema: string }>>`
			SELECT current_database() AS database, current_schema() AS schema
		`;
		if (target.database !== 'task7_release_cd_test' || target.schema !== 'public') {
			throw new Error('C/D test database identity did not match its isolated target');
		}
		const columns = await prisma.$queryRaw<Array<{ name: string; nullable: string }>>`
			SELECT column_name AS name, is_nullable AS nullable FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'Document' AND column_name IN ('content', 'body')
		`;
		hasLegacy = columns.some((column) => column.name === 'content');
		const bodyColumn = columns.find((column) => column.name === 'body');
		if (!bodyColumn) throw new Error('The C/D test database is missing body');
		bodyNullable = bodyColumn.nullable === 'YES';
		databaseVerified = true;
		await prisma.user.createMany({
			data: [...users].map(([id, email]) => ({
				id,
				email,
				name: 'C/D test user',
				password: 'fixture-without-password-login',
			})),
		});
		await prisma.workspace.create({
			data: {
				id: ids.workspace,
				name: 'C/D test workspace',
				members: {
					create: [
						{ userId: ids.owner, role: WorkspaceRole.OWNER },
						{ userId: ids.viewer, role: WorkspaceRole.VIEWER },
					],
				},
				projects: { create: { id: ids.project, name: 'C/D project', createdById: ids.owner } },
			},
		});
		await prisma.workspace.create({
			data: {
				id: ids.foreignWorkspace,
				name: 'Foreign C/D workspace',
				members: { create: { userId: ids.outsider, role: WorkspaceRole.OWNER } },
				projects: {
					create: {
						id: ids.foreignProject,
						name: 'Foreign C/D project',
						createdById: ids.outsider,
					},
				},
			},
		});
		const module = await Test.createTestingModule({
			controllers: [
				DocumentsController,
				ProjectDocumentsController,
				ProjectsController,
				DocumentFilesController,
			],
			providers: [
				DocumentsService,
				ProjectsService,
				AccessPolicyService,
				DocumentFilesService,
				{ provide: PrismaService, useValue: prisma },
				{ provide: CacheService, useValue: cache },
				{ provide: ConfigService, useValue: isolatedConfig({ DOCUMENT_FILE_MAX_BYTES: '1024' }) },
				{ provide: OBJECT_STORAGE, useValue: storage },
				{ provide: STORAGE_CONFIG, useValue: storageConfig },
			],
		})
			.overrideGuard(JwtAuthGuard)
			.useValue({
				canActivate(context: ExecutionContext) {
					const incoming = context.switchToHttp().getRequest<AuthenticatedRequest>();
					const userId = incoming.header('x-task7-user-id');
					const email = userId ? users.get(userId) : undefined;
					if (!userId || !email) throw new UnauthorizedException();
					incoming.user = { sub: userId, email };
					return true;
				},
			})
			.compile();
		app = module.createNestApplication();
		app.useGlobalPipes(createAppValidationPipe());
		await app.init();
		error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
	});

	beforeEach(() => {
		error.mockClear();
		cache.invalidateWorkspace.mockClear();
		for (const mock of Object.values(storage)) mock.mockClear();
	});

	afterEach(async () => {
		captureQueries = false;
		if (databaseVerified) await prisma.document.deleteMany({ where: { projectId: ids.project } });
	});

	afterAll(async () => {
		try {
			if (databaseVerified) {
				await prisma.workspace.deleteMany({
					where: { id: { in: [ids.workspace, ids.foreignWorkspace] } },
				});
				await prisma.user.deleteMany({ where: { id: { in: [...users.keys()] } } });
			}
		} finally {
			error?.mockRestore();
			if (app) await app.close();
			if (prisma) await prisma.$disconnect();
		}
	});

	it.each([
		{ created: '', updated: 'Body-only Unicode\n日本語 😀' },
		{ created: 'Original Unicode\n日本語 😀', updated: '' },
	])(
		'uses only body in all seven response paths and preserves legacy when present: %j',
		async ({ created, updated }) => {
			const response = await captured(async () =>
				request(app.getHttpServer())
					.post(`/projects/${ids.project}/documents`)
					.set(auth())
					.send({ title: 'Body-only HTTP document', content: created, body: 'Untrusted body' })
					.expect(201),
			);
			const document = publicDocument(response.body, created);
			expect((await storedBody(document.id)).body).toBe(created);
			expect(await legacy(document.id)).toBe(hasLegacy ? null : undefined);
			await setLegacy(document.id, 'Frozen legacy value');
			await readPaths(document.id, created);
			const patched = await captured(async () =>
				request(app.getHttpServer())
					.patch(`/documents/${document.id}`)
					.set(auth())
					.send({ content: updated })
					.expect(200),
			);
			publicDocument(patched.body, updated);
			expect((await storedBody(document.id)).body).toBe(updated);
			expect(await legacy(document.id)).toBe(hasLegacy ? 'Frozen legacy value' : undefined);
			const title = await captured(async () =>
				request(app.getHttpServer())
					.patch(`/documents/${document.id}`)
					.set(auth())
					.send({ title: 'Only title changed' })
					.expect(200),
			);
			publicDocument(title.body, updated);
			expect(await storedBody(document.id)).toMatchObject({
				title: 'Only title changed',
				body: updated,
			});
			expect(await legacy(document.id)).toBe(hasLegacy ? 'Frozen legacy value' : undefined);
			const archived = await captured(async () =>
				request(app.getHttpServer())
					.patch(`/documents/${document.id}/archive`)
					.set(auth())
					.expect(200),
			);
			publicDocument(archived.body, updated);
			expect(archived.body.status).toBe('ARCHIVED');
			const removed = await captured(async () =>
				request(app.getHttpServer()).delete(`/documents/${document.id}`).set(auth()).expect(200),
			);
			publicDocument(removed.body, updated);
			expect(
				await prisma.document.findUnique({ where: { id: document.id }, select: { id: true } }),
			).toBeNull();
			expect(cache.invalidateWorkspace).toHaveBeenCalledWith(ids.workspace);
		},
	);

	it('keeps concurrent body updates independent from legacy', async () => {
		const document = await fixtureDocument('Initial body');
		await setLegacy(document.id, 'Unchanged legacy');
		const values = Array.from({ length: 12 }, (_, index) => `Body update ${index} 😀`);
		await captured(async () => {
			await Promise.all(
				values.map(async (content) => {
					const response = await request(app.getHttpServer())
						.patch(`/documents/${document.id}`)
						.set(auth())
						.send({ content })
						.expect(200);
					publicDocument(response.body, content);
				}),
			);
		});
		expect(values).toContain((await storedBody(document.id)).body);
		expect(await legacy(document.id)).toBe(hasLegacy ? 'Unchanged legacy' : undefined);
	});

	it.each([null, 42, false, [], {}])(
		'rejects invalid PATCH content %j without writes',
		async (content) => {
			const document = await fixtureDocument('Body must survive');
			const before = await storedBody(document.id);
			await request(app.getHttpServer())
				.patch(`/documents/${document.id}`)
				.set(auth())
				.send({ title: 'Must not be applied', content })
				.expect(400);
			expect(await storedBody(document.id)).toEqual(before);
			expect(cache.invalidateWorkspace).not.toHaveBeenCalled();
		},
	);

	it('reports NULL body integrity before contract and rejects NULL at the DB boundary after contract', async () => {
		const documentId = `${runId}-invalid`;
		const insertNull = () => prisma.$executeRaw`
			INSERT INTO "Document" ("id", "projectId", "authorId", "title", "body", "updatedAt")
			VALUES (${documentId}, ${ids.project}, ${ids.owner}, 'NULL fixture', NULL, NOW())
		`;
		if (!bodyNullable) {
			await expect(insertNull()).rejects.toMatchObject({
				code: 'P2010',
				meta: expect.objectContaining({ code: '23502' }),
			});
			expect(await prisma.document.count({ where: { id: documentId } })).toBe(0);
			return;
		}
		await insertNull();
		await setLegacy(documentId, 'Legacy must not rescue a missing body');
		await captured(async () => {
			for (const path of [
				`/documents/${documentId}`,
				`/projects/${ids.project}/documents`,
				`/projects/${ids.project}`,
			]) {
				const response = await request(app.getHttpServer()).get(path).set(auth()).expect(500);
				expect(response.body).toMatchObject({ statusCode: 500 });
				expect(response.body).not.toHaveProperty('stack');
				expect(JSON.stringify(response.body)).not.toContain(documentId);
			}
		});
		const entries = error.mock.calls.flatMap(([message]: unknown[]) => {
			if (typeof message !== 'string') return [];
			try {
				const entry: unknown = JSON.parse(message);
				if (
					typeof entry === 'object' &&
					entry !== null &&
					'event' in entry &&
					entry.event === 'document.text.integrity_error'
				)
					return [entry];
			} catch {
				return [];
			}
			return [];
		});
		expect(entries).toHaveLength(3);
		for (const entry of entries) {
			expect(Object.keys(entry).sort()).toEqual(['count', 'event', 'instance', 'release']);
			expect(entry).toMatchObject({
				release: 'C',
				instance: expect.any(String),
				count: expect.any(Number),
			});
		}
	});

	it('preserves RBAC and hidden tenant checks without selecting legacy', async () => {
		const document = await fixtureDocument('Protected body');
		const before = await storedBody(document.id);
		await request(app.getHttpServer()).get(`/documents/${document.id}`).expect(401);
		await captured(async () => {
			const viewed = await request(app.getHttpServer())
				.get(`/documents/${document.id}`)
				.set(auth(ids.viewer))
				.expect(200);
			publicDocument(viewed.body, 'Protected body');
			await request(app.getHttpServer())
				.patch(`/documents/${document.id}`)
				.set(auth(ids.viewer))
				.send({ content: 'Denied' })
				.expect(403);
			await request(app.getHttpServer())
				.patch(`/documents/${document.id}/archive`)
				.set(auth(ids.viewer))
				.expect(403);
			await request(app.getHttpServer())
				.delete(`/documents/${document.id}`)
				.set(auth(ids.viewer))
				.expect(403);
			for (const path of [
				`/documents/${document.id}`,
				`/projects/${ids.project}/documents`,
				`/projects/${ids.project}`,
			]) {
				await request(app.getHttpServer()).get(path).set(auth(ids.outsider)).expect(404);
			}
			await request(app.getHttpServer())
				.get(`/projects/${ids.foreignProject}`)
				.set(auth())
				.expect(404);
		});
		expect(await storedBody(document.id)).toEqual(before);
	});

	it('authorizes every file/capabilities path through legacy-free AccessPolicy SQL', async () => {
		const document = await fixtureDocument('File owner body');
		await captured(async () => {
			const owner = await request(app.getHttpServer())
				.get(`/documents/${document.id}/files/capabilities`)
				.set(auth())
				.expect(200);
			expect(owner.body).toEqual({
				canUpdateDocument: true,
				canDeleteDocument: true,
				canManageFiles: true,
			});
			const viewer = await request(app.getHttpServer())
				.get(`/documents/${document.id}/files/capabilities`)
				.set(auth(ids.viewer))
				.expect(200);
			expect(viewer.body).toEqual({
				canUpdateDocument: false,
				canDeleteDocument: false,
				canManageFiles: false,
			});
			await request(app.getHttpServer())
				.get(`/documents/${document.id}/files`)
				.set(auth(ids.viewer))
				.expect(200)
				.expect([]);
			const uploaded = await request(app.getHttpServer())
				.post(`/documents/${document.id}/files/upload-url`)
				.set(auth())
				.send({ fileName: 'fixture.txt', mimeType: 'text/plain', size: 7 })
				.expect(201);
			const fileId = uploaded.body.file.id as string;
			expect(uploaded.body.file).not.toHaveProperty('objectKey');
			await request(app.getHttpServer())
				.post(`/documents/${document.id}/files/${fileId}/complete`)
				.set(auth())
				.expect(200);
			await request(app.getHttpServer())
				.get(`/documents/${document.id}/files/${fileId}/download-url`)
				.set(auth(ids.viewer))
				.expect(200);
			await request(app.getHttpServer())
				.post(`/documents/${document.id}/files/upload-url`)
				.set(auth(ids.viewer))
				.send({ fileName: 'denied.txt', mimeType: 'text/plain', size: 7 })
				.expect(403);
			await request(app.getHttpServer())
				.post(`/documents/${document.id}/files/${fileId}/complete`)
				.set(auth(ids.viewer))
				.expect(403);
			await request(app.getHttpServer())
				.delete(`/documents/${document.id}/files/${fileId}`)
				.set(auth(ids.viewer))
				.expect(403);
			for (const path of [
				`/documents/${document.id}/files`,
				`/documents/${document.id}/files/capabilities`,
				`/documents/${document.id}/files/${fileId}/download-url`,
			]) {
				await request(app.getHttpServer()).get(path).set(auth(ids.outsider)).expect(404);
			}
			await request(app.getHttpServer())
				.delete(`/documents/${document.id}/files/${fileId}`)
				.set(auth())
				.expect(204);
		});
		expect(storage.createUploadUrl).toHaveBeenCalledTimes(1);
		expect(storage.createDownloadUrl).toHaveBeenCalledTimes(1);
		expect(storage.head).toHaveBeenCalledTimes(1);
		expect(storage.remove).toHaveBeenCalledTimes(1);
		expect(await prisma.documentFile.count({ where: { documentId: document.id } })).toBe(0);
	});
});
