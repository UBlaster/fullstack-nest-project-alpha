import { randomUUID } from 'node:crypto';
import { ExecutionContext, INestApplication, Logger, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WorkspaceRole } from '@prisma/client';
import * as request from 'supertest';
import { seedDatabase } from '../prisma/seed';
import { AccessPolicyService } from '../src/access/access-policy.service';
import { AuthenticatedRequest } from '../src/auth/authenticated-request';
import { JwtAuthGuard } from '../src/auth/decorators/jwt-auth.decorator';
import { CacheService } from '../src/cache/cache.service';
import { DocumentsController } from '../src/documents/controllers/documents.controller';
import { ProjectDocumentsController } from '../src/documents/controllers/project-documents.controller';
import { DocumentsService } from '../src/documents/documents.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProjectsController } from '../src/projects/controllers/projects.controller';
import { ProjectsService } from '../src/projects/projects.service';
import { createAppValidationPipe } from '../src/validation.pipe';
import {
	createLegacyDocument,
	readLegacyDocument,
	updateLegacyDocument,
} from './document-legacy-sql';

const describeReleaseB = process.env.TASK7_RELEASE_B_E2E === 'true' ? describe : describe.skip;

function dedicatedDatabaseUrl(): string {
	const value = process.env.TASK7_RELEASE_B_DATABASE_URL;
	if (!value) throw new Error('TASK7_RELEASE_B_DATABASE_URL is required for this opt-in suite');
	let target: URL;
	try {
		target = new URL(value);
	} catch {
		throw new Error('Invalid Release B test database configuration');
	}
	if (
		!['postgres:', 'postgresql:'].includes(target.protocol) ||
		!['localhost', '127.0.0.1'].includes(target.hostname) ||
		target.port !== '55437' ||
		target.pathname !== '/task7_release_b_test' ||
		(target.searchParams.get('schema') ?? 'public') !== 'public' ||
		target.searchParams.getAll('schema').length > 1 ||
		[...target.searchParams.keys()].some((key) => key !== 'schema')
	) {
		throw new Error('Only the dedicated local task7_release_b_test database is allowed');
	}
	return value;
}

function publicDocument(value: unknown, content: string): { id: string; content: string } {
	expect(value).toMatchObject({ id: expect.any(String), content });
	expect(value).not.toHaveProperty('body');
	return value as { id: string; content: string };
}

function events(log: jest.SpyInstance, event: string): Array<Record<string, unknown>> {
	return log.mock.calls.flatMap(([message]: unknown[]) => {
		if (typeof message !== 'string') return [];
		try {
			const parsed: unknown = JSON.parse(message);
			if (
				typeof parsed === 'object' &&
				parsed !== null &&
				'event' in parsed &&
				parsed.event === event
			) {
				return [parsed as Record<string, unknown>];
			}
		} catch {
			return [];
		}
		return [];
	});
}

function safeEvents(entries: Array<Record<string, unknown>>) {
	for (const entry of entries) {
		expect(Object.keys(entry).sort()).toEqual(['count', 'event', 'instance', 'release']);
		expect(entry).toMatchObject({
			release: 'B',
			instance: expect.any(String),
			count: expect.any(Number),
		});
		expect(Number(entry.count)).toBeGreaterThan(0);
	}
	for (let index = 1; index < entries.length; index += 1) {
		expect(Number(entries[index].count)).toBeGreaterThan(Number(entries[index - 1].count));
	}
}

describeReleaseB('Task 7 Release B document HTTP/Prisma integration', () => {
	const runId = `task7-release-b-${randomUUID()}`;
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
	let app: INestApplication;
	let prisma: PrismaService;
	let warn: jest.SpyInstance;
	let error: jest.SpyInstance;
	let databaseVerified = false;
	let seedWorkspaceIds: string[] = [];
	let seedUserIds: string[] = [];
	const auth = (userId = ids.owner) => ({ 'x-task7-user-id': userId });
	const fixtureDocument = (content: string | null, body: string | null) =>
		createLegacyDocument(prisma, {
			title: 'Release B fixture',
			content,
			body,
			projectId: ids.project,
			authorId: ids.owner,
		});
	const storedText = (id: string) => readLegacyDocument(prisma, id);
	const seed = async () => {
		const originalRounds = process.env.BCRYPT_ROUNDS;
		const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
		try {
			process.env.BCRYPT_ROUNDS = '4';
			await seedDatabase(prisma);
		} finally {
			if (originalRounds === undefined) delete process.env.BCRYPT_ROUNDS;
			else process.env.BCRYPT_ROUNDS = originalRounds;
			log.mockRestore();
		}
	};
	const readThroughAllPaths = async (id: string, expected: string) => {
		const fetched = await request(app.getHttpServer())
			.get(`/documents/${id}`)
			.set(auth())
			.expect(200);
		publicDocument(fetched.body, expected);
		expect(fetched.body).toMatchObject({
			author: { name: 'Release B test user' },
			project: { id: ids.project, workspaceId: ids.workspace },
		});
		const listed = await request(app.getHttpServer())
			.get(`/projects/${ids.project}/documents`)
			.set(auth())
			.expect(200);
		const listedDocuments = listed.body as Array<{ id: string }>;
		const listedDocument = listedDocuments.find((row) => row.id === id);
		publicDocument(listedDocument, expected);
		expect(listedDocument).toMatchObject({ author: { name: 'Release B test user' } });
		const project = await request(app.getHttpServer())
			.get(`/projects/${ids.project}`)
			.set(auth())
			.expect(200);
		const nestedDocuments = project.body.documents as Array<{ id: string }>;
		const nested = nestedDocuments.find((row) => row.id === id);
		publicDocument(nested, expected);
		expect(nested).toMatchObject({ author: { name: 'Release B test user' } });
	};

	beforeAll(async () => {
		prisma = new PrismaService({ datasources: { db: { url: dedicatedDatabaseUrl() } } });
		await prisma.$connect();
		const [target] = await prisma.$queryRaw<Array<{ database: string; schema: string }>>`
			SELECT current_database() AS database, current_schema() AS schema
		`;
		if (target.database !== 'task7_release_b_test' || target.schema !== 'public') {
			throw new Error('Release B test database identity did not match its isolated target');
		}
		if ((await prisma.user.count()) !== 0 || (await prisma.document.count()) !== 0) {
			throw new Error('The dedicated Release B database must start without users/documents');
		}
		databaseVerified = true;
		try {
			await seed();
		} finally {
			// База была пустой: фиксируем только созданные этим вызовом seed строки для cleanup.
			seedWorkspaceIds = (await prisma.workspace.findMany({ select: { id: true } })).map(
				(row) => row.id,
			);
			seedUserIds = (await prisma.user.findMany({ select: { id: true } })).map((row) => row.id);
		}
		await prisma.user.createMany({
			data: [...users].map(([id, email]) => ({
				id,
				email,
				name: 'Release B test user',
				password: 'fixture-without-password-login',
			})),
		});
		await prisma.workspace.create({
			data: {
				id: ids.workspace,
				name: 'Release B isolated workspace',
				members: {
					create: [
						{ userId: ids.owner, role: WorkspaceRole.OWNER },
						{ userId: ids.viewer, role: WorkspaceRole.VIEWER },
					],
				},
				projects: {
					create: { id: ids.project, name: 'Release B project', createdById: ids.owner },
				},
			},
		});
		await prisma.workspace.create({
			data: {
				id: ids.foreignWorkspace,
				name: 'Release B foreign workspace',
				members: { create: { userId: ids.outsider, role: WorkspaceRole.OWNER } },
				projects: {
					create: { id: ids.foreignProject, name: 'Foreign B project', createdById: ids.outsider },
				},
			},
		});
		const module = await Test.createTestingModule({
			controllers: [DocumentsController, ProjectDocumentsController, ProjectsController],
			providers: [
				DocumentsService,
				ProjectsService,
				AccessPolicyService,
				{ provide: PrismaService, useValue: prisma },
				{ provide: CacheService, useValue: cache },
			],
		})
			.overrideGuard(JwtAuthGuard)
			.useValue({
				// Аутентификация изолирована, AccessPolicy проверяет реальные membership/RBAC в БД.
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
		warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
		error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
	}, 60_000);

	beforeEach(() => {
		warn.mockClear();
		error.mockClear();
		cache.invalidateWorkspace.mockClear();
	});

	afterEach(async () => {
		if (databaseVerified) await prisma.document.deleteMany({ where: { projectId: ids.project } });
	});

	afterAll(async () => {
		try {
			if (databaseVerified) {
				await prisma.workspace.deleteMany({
					where: { id: { in: [...seedWorkspaceIds, ids.workspace, ids.foreignWorkspace] } },
				});
				await prisma.user.deleteMany({ where: { id: { in: [...seedUserIds, ...users.keys()] } } });
			}
		} finally {
			warn?.mockRestore();
			error?.mockRestore();
			if (app) await app.close();
			else if (prisma) await prisma.$disconnect();
		}
	});

	it('seeds equal pairs on an empty B schema and never rewrites existing document text', async () => {
		expect(
			await prisma.document.count({
				where: { project: { workspaceId: { in: seedWorkspaceIds } } },
			}),
		).toBe(3600);
		const [counts] = await prisma.$queryRaw<Array<{ missing: number; mismatch: number }>>`
			SELECT (COUNT(*) FILTER (WHERE "body" IS NULL OR "content" IS NULL))::int AS missing,
				(COUNT(*) FILTER (WHERE "body" IS DISTINCT FROM "content"))::int AS mismatch
			FROM "Document"
		`;
		expect(counts).toEqual({ missing: 0, mismatch: 0 });
		const seededDocument = await prisma.document.findFirstOrThrow({
			where: { project: { workspaceId: { in: seedWorkspaceIds } } },
			orderBy: { id: 'asc' },
			select: { id: true },
		});
		const document = await storedText(seededDocument.id);
		await updateLegacyDocument(prisma, document.id, { body: null });
		const before = await storedText(document.id);
		try {
			await seed();
			expect(await storedText(document.id)).toEqual(before);
			expect(await prisma.document.count()).toBe(3600);
		} finally {
			await updateLegacyDocument(prisma, document.id, {
				body: document.body,
				updatedAt: document.updatedAt,
			});
		}
	});

	it.each([
		{ legacy: 'Older legacy', body: 'Current body' },
		{ legacy: 'Nonempty legacy', body: '' },
		{ legacy: null, body: 'Decoded with nullable legacy' },
		{ legacy: null, body: '' },
	])(
		'prefers body on every read path with legacy=$legacy and body=$body',
		async ({ legacy, body }) => {
			const document = await fixtureDocument(legacy, body);
			const before = await storedText(document.id);
			await readThroughAllPaths(document.id, body);
			expect(await storedText(document.id)).toEqual(before);
			expect(events(warn, 'document.text.fallback')).toHaveLength(0);
			expect(events(error, 'document.text.integrity_error')).toHaveLength(0);
		},
	);

	it.each(['', 'Legacy Unicode\n日本語 😀'])(
		'falls back to legacy %j with safe cumulative events and no repairs',
		async (legacy) => {
			const document = await fixtureDocument(legacy, null);
			const before = await storedText(document.id);
			await readThroughAllPaths(document.id, legacy);
			expect(await storedText(document.id)).toEqual(before);
			const fallback = events(warn, 'document.text.fallback');
			expect(fallback).toHaveLength(3);
			safeEvents(fallback);
			expect(JSON.stringify(fallback)).not.toContain(document.id);
			if (legacy !== '') expect(JSON.stringify(fallback)).not.toContain(legacy);
			expect(events(error, 'document.text.integrity_error')).toHaveLength(0);
		},
	);

	it('returns safe integrity errors for two NULLs without modifying the document', async () => {
		const document = await fixtureDocument(null, null);
		const before = await storedText(document.id);
		for (const path of [
			`/documents/${document.id}`,
			`/projects/${ids.project}/documents`,
			`/projects/${ids.project}`,
		]) {
			const response = await request(app.getHttpServer()).get(path).set(auth()).expect(500);
			expect(response.body).toMatchObject({ statusCode: 500 });
			expect(response.body).not.toHaveProperty('content');
			expect(response.body).not.toHaveProperty('body');
			expect(response.body).not.toHaveProperty('stack');
			expect(JSON.stringify(response.body)).not.toContain(document.id);
		}
		expect(await storedText(document.id)).toEqual(before);
		const integrity = events(error, 'document.text.integrity_error');
		expect(integrity).toHaveLength(3);
		safeEvents(integrity);
		expect(JSON.stringify(integrity)).not.toContain(document.id);
		expect(events(warn, 'document.text.fallback')).toHaveLength(0);
	});

	it.each([
		{ created: '', updated: 'New Unicode\n日本語 😀' },
		{ created: 'Original Unicode\n日本語 😀', updated: '' },
	])(
		'dual-writes mutations and keeps all seven response contracts: %j',
		async ({ created, updated }) => {
			const response = await request(app.getHttpServer())
				.post(`/projects/${ids.project}/documents`)
				.set(auth())
				.send({ title: 'B HTTP document', content: created, body: 'Untrusted field' })
				.expect(201);
			const document = publicDocument(response.body, created);
			expect(await storedText(document.id)).toMatchObject({ content: created, body: created });
			await updateLegacyDocument(prisma, document.id, { content: 'Stale legacy value' });
			await readThroughAllPaths(document.id, created);
			const patched = await request(app.getHttpServer())
				.patch(`/documents/${document.id}`)
				.set(auth())
				.send({ content: updated })
				.expect(200);
			publicDocument(patched.body, updated);
			expect(await storedText(document.id)).toMatchObject({ content: updated, body: updated });
			await updateLegacyDocument(prisma, document.id, { content: null });
			const archived = await request(app.getHttpServer())
				.patch(`/documents/${document.id}/archive`)
				.set(auth())
				.expect(200);
			publicDocument(archived.body, updated);
			expect(archived.body.status).toBe('ARCHIVED');
			expect(await storedText(document.id)).toMatchObject({ content: null, body: updated });
			const removed = await request(app.getHttpServer())
				.delete(`/documents/${document.id}`)
				.set(auth())
				.expect(200);
			publicDocument(removed.body, updated);
			expect(await prisma.document.findUnique({ where: { id: document.id } })).toBeNull();
			expect(cache.invalidateWorkspace).toHaveBeenCalledWith(ids.workspace);
			expect(events(warn, 'document.text.fallback')).toHaveLength(0);
		},
	);

	it('does not repair either text column during a title-only PATCH', async () => {
		const document = await fixtureDocument('Preserved legacy', 'Current body');
		const response = await request(app.getHttpServer())
			.patch(`/documents/${document.id}`)
			.set(auth())
			.send({ title: 'Only the title changes' })
			.expect(200);
		publicDocument(response.body, 'Current body');
		expect(await storedText(document.id)).toMatchObject({
			title: 'Only the title changes',
			content: 'Preserved legacy',
			body: 'Current body',
		});
		expect(events(warn, 'document.text.fallback')).toHaveLength(0);
	});

	it.each([null, 42, false, [], {}])(
		'rejects invalid PATCH content %j before any write',
		async (content) => {
			const document = await fixtureDocument('Legacy kept', 'Body kept');
			const before = await storedText(document.id);
			await request(app.getHttpServer())
				.patch(`/documents/${document.id}`)
				.set(auth())
				.send({ title: 'Must not be saved', content })
				.expect(400);
			expect(await storedText(document.id)).toEqual(before);
			expect(cache.invalidateWorkspace).not.toHaveBeenCalled();
		},
	);

	it('preserves VIEWER denial, hidden tenant access and authorization before text mapping', async () => {
		const document = await fixtureDocument(null, 'Visible body');
		const corrupt = await fixtureDocument(null, null);
		const before = await storedText(document.id);
		await request(app.getHttpServer()).get(`/documents/${document.id}`).expect(401);
		const viewed = await request(app.getHttpServer())
			.get(`/documents/${document.id}`)
			.set(auth(ids.viewer))
			.expect(200);
		publicDocument(viewed.body, 'Visible body');
		await request(app.getHttpServer())
			.post(`/projects/${ids.project}/documents`)
			.set(auth(ids.viewer))
			.send({ title: 'Denied', content: 'Denied' })
			.expect(403);
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
			`/documents/${corrupt.id}`,
			`/projects/${ids.project}/documents`,
			`/projects/${ids.project}`,
		]) {
			await request(app.getHttpServer()).get(path).set(auth(ids.outsider)).expect(404);
		}
		await request(app.getHttpServer())
			.get(`/projects/${ids.foreignProject}`)
			.set(auth())
			.expect(404);
		expect(await storedText(document.id)).toEqual(before);
		expect(events(error, 'document.text.integrity_error')).toHaveLength(0);
	});
});
