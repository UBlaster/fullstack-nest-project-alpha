import { randomUUID } from 'node:crypto';
import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { WorkspaceRole } from '@prisma/client';
import * as request from 'supertest';
import { AccessPolicyService } from '../src/access/access-policy.service';
import { AuthenticatedRequest } from '../src/auth/authenticated-request';
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

const describeReleaseA = process.env.TASK7_RELEASE_A_E2E === 'true' ? describe : describe.skip;

function dedicatedDatabaseUrl(): string {
	const value = process.env.TASK7_RELEASE_A_DATABASE_URL;
	if (!value) throw new Error('TASK7_RELEASE_A_DATABASE_URL is required for this opt-in suite');
	let target: URL;
	try {
		target = new URL(value);
	} catch {
		throw new Error('Invalid Release A test database configuration');
	}
	if (
		!['postgres:', 'postgresql:'].includes(target.protocol) ||
		!['localhost', '127.0.0.1'].includes(target.hostname) ||
		target.port !== '55437' ||
		target.pathname !== '/task7_release_a_test' ||
		(target.searchParams.get('schema') ?? 'public') !== 'public' ||
		target.searchParams.getAll('schema').length > 1 ||
		[...target.searchParams.keys()].some((key) => key !== 'schema')
	) {
		throw new Error('Only the dedicated local task7_release_a_test database is allowed');
	}
	return value;
}

function publicDocument(value: unknown, content: string): { id: string; content: string } {
	expect(value).toMatchObject({ id: expect.any(String), content });
	expect(value).not.toHaveProperty('body');
	return value as { id: string; content: string };
}

describeReleaseA('Task 7 Release A document HTTP/Prisma integration', () => {
	const runId = `task7-release-a-${randomUUID()}`;
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
	let accessPolicy: AccessPolicyService;
	let databaseVerified = false;

	const auth = (userId = ids.owner) => ({ 'x-task7-user-id': userId });
	const fixtureDocument = (content: string, body: string | null = content) =>
		createLegacyDocument(prisma, {
			title: 'Release A fixture',
			content,
			body,
			projectId: ids.project,
			authorId: ids.owner,
		});
	const storedText = (id: string) => readLegacyDocument(prisma, id);

	beforeAll(async () => {
		prisma = new PrismaService({ datasources: { db: { url: dedicatedDatabaseUrl() } } });
		await prisma.$connect();
		const [target] = await prisma.$queryRaw<Array<{ database: string; schema: string }>>`
			SELECT current_database() AS database, current_schema() AS schema
		`;
		if (target.database !== 'task7_release_a_test' || target.schema !== 'public') {
			throw new Error('Release A test database identity did not match its isolated target');
		}
		databaseVerified = true;

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
			.overrideGuard(AuthGuard('jwt'))
			.useValue({
				// Изолируем аутентификацию; настоящий AccessPolicy проверяет членство и права в БД.
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
		accessPolicy = app.get(AccessPolicyService);

		await prisma.user.createMany({
			data: [...users].map(([id, email]) => ({
				id,
				email,
				name: 'Release A test user',
				password: 'fixture-without-password-login',
			})),
		});
		await prisma.workspace.create({
			data: {
				id: ids.workspace,
				name: 'Release A isolated workspace',
				members: {
					create: [
						{ userId: ids.owner, role: WorkspaceRole.OWNER },
						{ userId: ids.viewer, role: WorkspaceRole.VIEWER },
					],
				},
				projects: {
					create: { id: ids.project, name: 'Release A project', createdById: ids.owner },
				},
			},
		});
		await prisma.workspace.create({
			data: {
				id: ids.foreignWorkspace,
				name: 'Release A foreign workspace',
				members: { create: { userId: ids.outsider, role: WorkspaceRole.OWNER } },
				projects: {
					create: {
						id: ids.foreignProject,
						name: 'Release A foreign project',
						createdById: ids.outsider,
					},
				},
			},
		});
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
			if (app) await app.close();
			else if (prisma) await prisma.$disconnect();
		}
	});

	it.each([
		{ created: '', updated: 'Новый текст\nUnicode: 日本語 😀' },
		{ created: 'Исходный текст\nUnicode: 日本語 😀', updated: '' },
	])('dual-writes create/update and keeps the old API contract: %j', async (text) => {
		const created = await request(app.getHttpServer())
			.post(`/projects/${ids.project}/documents`)
			.set(auth())
			.send({ title: 'Created over HTTP', content: text.created, body: 'Untrusted field' })
			.expect(201);
		const document = publicDocument(created.body, text.created);
		expect(await storedText(document.id)).toMatchObject({
			content: text.created,
			body: text.created,
		});

		const listed = await request(app.getHttpServer())
			.get(`/projects/${ids.project}/documents`)
			.set(auth())
			.expect(200);
		const listedDocuments = listed.body as Array<{ id: string }>;
		publicDocument(
			listedDocuments.find((row) => row.id === document.id),
			text.created,
		);
		const fetched = await request(app.getHttpServer())
			.get(`/documents/${document.id}`)
			.set(auth())
			.expect(200);
		publicDocument(fetched.body, text.created);
		expect(fetched.body).toMatchObject({
			author: { name: 'Release A test user' },
			project: { id: ids.project, workspaceId: ids.workspace },
		});
		const project = await request(app.getHttpServer())
			.get(`/projects/${ids.project}`)
			.set(auth())
			.expect(200);
		const nestedDocuments = project.body.documents as Array<{ id: string }>;
		const nested = nestedDocuments.find((row) => row.id === document.id);
		publicDocument(nested, text.created);
		expect(nested).toMatchObject({ author: { name: 'Release A test user' } });

		const updated = await request(app.getHttpServer())
			.patch(`/documents/${document.id}`)
			.set(auth())
			.send({ content: text.updated })
			.expect(200);
		publicDocument(updated.body, text.updated);
		expect(await storedText(document.id)).toMatchObject({
			content: text.updated,
			body: text.updated,
		});
		const archived = await request(app.getHttpServer())
			.patch(`/documents/${document.id}/archive`)
			.set(auth())
			.expect(200);
		publicDocument(archived.body, text.updated);
		expect(archived.body.status).toBe('ARCHIVED');
		const removed = await request(app.getHttpServer())
			.delete(`/documents/${document.id}`)
			.set(auth())
			.expect(200);
		publicDocument(removed.body, text.updated);
		expect(await prisma.document.findUnique({ where: { id: document.id } })).toBeNull();
		expect(cache.invalidateWorkspace).toHaveBeenCalledWith(ids.workspace);
	});

	it.each([null, 'Stale body from another version'])(
		'reads legacy content while body is %j without exposing body',
		async (body) => {
			const document = await fixtureDocument('Current legacy value', body);
			const response = await request(app.getHttpServer())
				.get(`/documents/${document.id}`)
				.set(auth())
				.expect(200);
			publicDocument(response.body, 'Current legacy value');
			const listed = await request(app.getHttpServer())
				.get(`/projects/${ids.project}/documents`)
				.set(auth())
				.expect(200);
			const listedDocuments = listed.body as Array<{ id: string }>;
			publicDocument(
				listedDocuments.find((row) => row.id === document.id),
				'Current legacy value',
			);
			const project = await request(app.getHttpServer())
				.get(`/projects/${ids.project}`)
				.set(auth())
				.expect(200);
			const nestedDocuments = project.body.documents as Array<{ id: string }>;
			publicDocument(
				nestedDocuments.find((row) => row.id === document.id),
				'Current legacy value',
			);
			expect(await storedText(document.id)).toMatchObject({
				content: document.content,
				body,
			});
		},
	);

	it('does not overwrite either text field when a legacy writer races with title-only PATCH', async () => {
		const document = await fixtureDocument('Legacy before access check', 'Existing body');
		const requireDocument = accessPolicy.requireDocument.bind(accessPolicy);
		const access = jest
			.spyOn(accessPolicy, 'requireDocument')
			.mockImplementationOnce(async (...args) => {
				const context = await requireDocument(...args);
				// Реальный legacy UPDATE после чтения контекста доступа, перед записью заголовка.
				await updateLegacyDocument(prisma, document.id, {
					content: 'Fresh legacy value after access check',
				});
				return context;
			});
		try {
			const response = await request(app.getHttpServer())
				.patch(`/documents/${document.id}`)
				.set(auth())
				.send({ title: 'Only the title changes' })
				.expect(200);
			publicDocument(response.body, 'Fresh legacy value after access check');
			expect(await storedText(document.id)).toMatchObject({
				title: 'Only the title changes',
				content: 'Fresh legacy value after access check',
				body: 'Existing body',
			});
		} finally {
			access.mockRestore();
		}
	});

	it('keeps the two stored values equal under concurrent text updates', async () => {
		const document = await fixtureDocument('Initial text');
		const texts = Array.from({ length: 12 }, (_, index) => `Concurrent text ${index} 😀`);
		await Promise.all(
			texts.map(async (content) => {
				const response = await request(app.getHttpServer())
					.patch(`/documents/${document.id}`)
					.set(auth())
					.send({ content })
					.expect(200);
				publicDocument(response.body, content);
			}),
		);
		const stored = await storedText(document.id);
		expect(texts).toContain(stored.content);
		expect(stored.body).toBe(stored.content);
	});

	it.each([null, 42, false, [], {}])(
		'rejects non-string content %j without database changes',
		async (content) => {
			const document = await fixtureDocument('Text that must survive');
			const before = await storedText(document.id);
			const count = await prisma.document.count({ where: { projectId: ids.project } });
			await request(app.getHttpServer())
				.patch(`/documents/${document.id}`)
				.set(auth())
				.send({ title: 'Must not be saved', content })
				.expect(400);
			expect(await storedText(document.id)).toEqual(before);
			await request(app.getHttpServer())
				.post(`/projects/${ids.project}/documents`)
				.set(auth())
				.send({ title: 'Must not be created', content })
				.expect(400);
			expect(await prisma.document.count({ where: { projectId: ids.project } })).toBe(count);
		},
	);

	it('preserves VIEWER mutation denial and hidden foreign-workspace access', async () => {
		const document = await fixtureDocument('Protected text');
		const before = await storedText(document.id);
		await request(app.getHttpServer()).get(`/documents/${document.id}`).expect(401);
		const viewed = await request(app.getHttpServer())
			.get(`/documents/${document.id}`)
			.set(auth(ids.viewer))
			.expect(200);
		publicDocument(viewed.body, 'Protected text');
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
			.delete(`/documents/${document.id}`)
			.set(auth(ids.viewer))
			.expect(403);
		await request(app.getHttpServer())
			.patch(`/documents/${document.id}/archive`)
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
			.patch(`/documents/${document.id}`)
			.set(auth(ids.outsider))
			.send({ content: 'Hidden' })
			.expect(404);
		await request(app.getHttpServer())
			.get(`/projects/${ids.foreignProject}`)
			.set(auth())
			.expect(404);
		expect(await storedText(document.id)).toEqual(before);
	});
});
