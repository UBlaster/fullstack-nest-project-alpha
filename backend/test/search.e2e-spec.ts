import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentStatus, WorkspaceRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createAppValidationPipe } from '../src/validation.pipe';

const password = 'password123';
const workspaceId = 'task3-e2e-workspace';
const foreignWorkspaceId = 'task3-e2e-foreign-workspace';
const projectId = 'task3-e2e-project';
const secondProjectId = 'task3-e2e-second-project';
const foreignProjectId = 'task3-e2e-foreign-project';
const searchPath = `/workspaces/${workspaceId}/documents/search`;
const emails = {
	owner: 'task3-owner@example.com',
	member: 'task3-member@example.com',
	viewer: 'task3-viewer@example.com',
	outsider: 'task3-outsider@example.com',
	foreignOwner: 'task3-foreign-owner@example.com',
};

interface SearchResult {
	id: string;
	projectId: string;
	title: string;
	status: DocumentStatus;
	updatedAt: string;
	author: { name: string };
	score: number;
}

describe('Task 3 PostgreSQL document search (e2e)', () => {
	let app: INestApplication;
	let prisma: PrismaService;
	let ownerToken: string;
	let memberToken: string;
	let viewerToken: string;
	let outsiderToken: string;

	const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
	const search = (token: string, query: Record<string, unknown>) =>
		request(app.getHttpServer()).get(searchPath).set(auth(token)).query(query);
	const login = async (email: string) => {
		const response = await request(app.getHttpServer())
			.post('/auth/login')
			.send({ email, password })
			.expect(200);
		return response.body.accessToken as string;
	};

	beforeAll(async () => {
		const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
		app = moduleFixture.createNestApplication();
		app.useGlobalPipes(createAppValidationPipe());
		await app.init();
		prisma = app.get(PrismaService);

		await prisma.workspace.deleteMany({
			where: { id: { in: [workspaceId, foreignWorkspaceId] } },
		});
		await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });

		const passwordHash = await bcrypt.hash(password, 4);
		const [owner, member, viewer, , foreignOwner] = await Promise.all(
			Object.entries(emails).map(([role, email]) =>
				prisma.user.create({
					data: { email, name: `Task 3 ${role}`, password: passwordHash },
				}),
			),
		);

		await prisma.workspace.create({
			data: {
				id: workspaceId,
				name: 'Task 3 Workspace',
				members: {
					create: [
						{ userId: owner.id, role: WorkspaceRole.OWNER },
						{ userId: member.id, role: WorkspaceRole.MEMBER },
						{ userId: viewer.id, role: WorkspaceRole.VIEWER },
					],
				},
				projects: {
					create: [
						{ id: projectId, name: 'Task 3 Project', createdById: owner.id },
						{ id: secondProjectId, name: 'Task 3 Second Project', createdById: member.id },
					],
				},
			},
		});
		await prisma.workspace.create({
			data: {
				id: foreignWorkspaceId,
				name: 'Task 3 Foreign Workspace',
				members: { create: { userId: foreignOwner.id, role: WorkspaceRole.OWNER } },
				projects: {
					create: {
						id: foreignProjectId,
						name: 'Task 3 Foreign Project',
						createdById: foreignOwner.id,
					},
				},
			},
		});

		const commonUpdatedAt = new Date('2026-01-02T12:00:00.000Z');
		const document = (
			id: string,
			title: string,
			overrides: Partial<{
				projectId: string;
				authorId: string;
				content: string;
				status: DocumentStatus;
				updatedAt: Date;
			}> = {},
		) => ({
			id,
			projectId,
			authorId: owner.id,
			title,
			content: '',
			status: DocumentStatus.ACTIVE,
			updatedAt: commonUpdatedAt,
			...overrides,
		});

		await prisma.document.createMany({
			data: [
				document('task3-contract-exact', 'API deployment handbook', {
					content: 'private exact-match body',
				}),
				document('task3-contract-typo', 'API deplyoment handbook', {
					projectId: secondProjectId,
					authorId: member.id,
					content: 'private typo body',
					status: DocumentStatus.DRAFT,
				}),
				document('task3-contract-case', 'api deployment HANDBOOK', {
					content: 'private case body',
				}),
				document('task3-content-only', 'Completely unrelated subject', {
					content: 'API deployment handbook',
				}),
				document('task3-archived', 'Archived obsidian beacon', {
					content: 'must stay private',
					status: DocumentStatus.ARCHIVED,
				}),
				document('task3-rank-a', 'Quasar ranking nebula'),
				document('task3-rank-b', 'Quasar ranking nebula'),
				document('task3-rank-old', 'Quasar ranking nebula', {
					updatedAt: new Date('2026-01-01T12:00:00.000Z'),
				}),
				document('task3-rank-lower-score', 'Quasar rankng nebula', {
					updatedAt: new Date('2026-01-03T12:00:00.000Z'),
				}),
				...Array.from({ length: 5 }, (_, index) =>
					document(`task3-page-${String(index + 1).padStart(2, '0')}`, 'Pagination zephyr orchard'),
				),
				...Array.from({ length: 25 }, (_, index) =>
					document(`task3-default-${String(index + 1).padStart(2, '0')}`, 'Default cobalt lantern'),
				),
			],
		});
		await prisma.document.create({
			data: document('task3-foreign-document', 'API deployment handbook', {
				projectId: foreignProjectId,
				authorId: foreignOwner.id,
				content: 'foreign private body',
			}),
		});

		[ownerToken, memberToken, viewerToken, outsiderToken] = await Promise.all([
			login(emails.owner),
			login(emails.member),
			login(emails.viewer),
			login(emails.outsider),
		]);
	});

	afterAll(async () => {
		await prisma.workspace.deleteMany({
			where: { id: { in: [workspaceId, foreignWorkspaceId] } },
		});
		await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
		await app.close();
	});

	it('returns 401 without JWT', async () => {
		await request(app.getHttpServer()).get(searchPath).query({ q: 'api' }).expect(401);
	});

	it.each([
		['OWNER', () => ownerToken],
		['MEMBER', () => memberToken],
		['VIEWER', () => viewerToken],
	])('allows %s to search documents in the workspace', async (_role, getToken) => {
		const response = await search(getToken(), { q: 'API deployment handbook' }).expect(200);
		const ids = response.body.map((result: SearchResult) => result.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				'task3-contract-exact',
				'task3-contract-typo',
				'task3-contract-case',
			]),
		);
	});

	it('returns hidden 404 for an outsider and a missing workspace', async () => {
		await search(outsiderToken, { q: 'API deployment handbook' }).expect(404);
		await request(app.getHttpServer())
			.get('/workspaces/task3-e2e-missing/documents/search')
			.set(auth(ownerToken))
			.query({ q: 'API deployment handbook' })
			.expect(404);
	});

	it('keeps workspace isolation inside search results', async () => {
		const response = await search(ownerToken, { q: 'API deployment handbook', limit: 50 }).expect(
			200,
		);
		const ids = response.body.map((result: SearchResult) => result.id);
		expect(ids).not.toContain('task3-foreign-document');
		expect(ids).toContain('task3-contract-exact');
	});

	it('matches exact text, a typo and different case after trimming q', async () => {
		const response = await search(ownerToken, { q: '  API deployment handbook  ' }).expect(200);
		const ids = response.body.map((result: SearchResult) => result.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				'task3-contract-exact',
				'task3-contract-typo',
				'task3-contract-case',
			]),
		);
		expect(ids).not.toContain('task3-content-only');
	});

	it.each([
		['missing q', {}],
		['empty q', { q: '' }],
		['whitespace-only q', { q: '   ' }],
		['one-character q', { q: 'a' }],
		['q longer than 100 characters', { q: 'a'.repeat(101) }],
		['non-string q', { q: ['api', 'docs'] }],
		['limit below the minimum', { q: 'api', limit: 0 }],
		['limit above the maximum', { q: 'api', limit: 51 }],
		['fractional limit', { q: 'api', limit: 1.5 }],
		['non-numeric limit', { q: 'api', limit: 'abc' }],
		['empty limit instead of a missing limit', { q: 'api', limit: '' }],
		['negative offset', { q: 'api', offset: -1 }],
		['offset above the maximum', { q: 'api', offset: 5001 }],
		['fractional offset', { q: 'api', offset: 1.5 }],
		['non-numeric offset', { q: 'api', offset: 'abc' }],
		['empty offset instead of a missing offset', { q: 'api', offset: '' }],
	])('returns 400 for %s', async (_case, query) => {
		await search(ownerToken, query).expect(400);
	});

	it('uses limit=20 and offset=0 when pagination parameters are absent', async () => {
		const implicit = await search(ownerToken, { q: 'Default cobalt lantern' }).expect(200);
		const explicit = await search(ownerToken, {
			q: 'Default cobalt lantern',
			limit: 20,
			offset: 0,
		}).expect(200);
		expect(implicit.body).toHaveLength(20);
		expect(implicit.body.map((result: SearchResult) => result.id)).toEqual(
			explicit.body.map((result: SearchResult) => result.id),
		);
	});

	it('sorts by score DESC, updatedAt DESC and id ASC', async () => {
		const response = await search(ownerToken, { q: 'Quasar ranking nebula' }).expect(200);
		expect(response.body.map((result: SearchResult) => result.id)).toEqual([
			'task3-rank-a',
			'task3-rank-b',
			'task3-rank-old',
			'task3-rank-lower-score',
		]);
		expect(response.body[0].score).toBe(response.body[1].score);
		expect(response.body[1].score).toBe(response.body[2].score);
		expect(response.body[2].score).toBeGreaterThan(response.body[3].score);
	});

	it('returns adjacent stable pages without duplicates', async () => {
		const first = await search(ownerToken, {
			q: 'Pagination zephyr orchard',
			limit: 2,
			offset: 0,
		}).expect(200);
		const second = await search(ownerToken, {
			q: 'Pagination zephyr orchard',
			limit: 2,
			offset: 2,
		}).expect(200);
		const firstIds = first.body.map((result: SearchResult) => result.id);
		const secondIds = second.body.map((result: SearchResult) => result.id);
		expect(firstIds).toEqual(['task3-page-01', 'task3-page-02']);
		expect(secondIds).toEqual(['task3-page-03', 'task3-page-04']);
		expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);
	});

	it('includes ARCHIVED documents and returns only the public response shape', async () => {
		const response = await search(ownerToken, { q: 'Archived obsidian beacon' }).expect(200);
		expect(response.body).toHaveLength(1);
		expect(response.body[0]).toEqual(
			expect.objectContaining({
				id: 'task3-archived',
				projectId,
				title: 'Archived obsidian beacon',
				status: DocumentStatus.ARCHIVED,
				author: { name: 'Task 3 owner' },
			}),
		);
		expect(typeof response.body[0].updatedAt).toBe('string');
		expect(typeof response.body[0].score).toBe('number');
		expect(Object.keys(response.body[0]).sort()).toEqual(
			['author', 'id', 'projectId', 'score', 'status', 'title', 'updatedAt'].sort(),
		);
		expect(Object.keys(response.body[0].author)).toEqual(['name']);
		expect(response.body[0]).not.toHaveProperty('content');
	});

	it('treats SQL-like input as data and does not leak documents', async () => {
		const payload = "API deployment handbook' OR 1=1 --";
		const response = await search(ownerToken, { q: payload, limit: 50 }).expect(200);
		const ids = response.body.map((result: SearchResult) => result.id);
		expect(ids).not.toContain('task3-foreign-document');
		expect(ids).not.toContain('task3-content-only');
		expect(response.body.length).toBeLessThan(40);
	});
});
