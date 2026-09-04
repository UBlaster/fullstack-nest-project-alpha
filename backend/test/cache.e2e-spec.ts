import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WorkspaceRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import Redis from 'ioredis';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { CacheModule } from '../src/cache/cache.module';
import { CacheService, ttlWithJitter } from '../src/cache/cache.service';
import { REDIS_CLIENT } from '../src/cache/cache.tokens';
import { PrismaService } from '../src/prisma/prisma.service';
import { createAppValidationPipe } from '../src/validation.pipe';

const redisDown = process.env.TASK4_REDIS_DOWN === 'true';
const describeWithRedis = redisDown ? describe.skip : describe;
const describeWithoutRedis = redisDown ? describe : describe.skip;
const password = 'password123';
const runId = `task4-e2e-${process.pid}-${Date.now()}`;

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

interface SearchResult {
	id: string;
	projectId: string;
	title: string;
	status: string;
	updatedAt: string;
	author: { name: string };
	score: number;
}

describeWithRedis('Task 4 Redis cache-aside (e2e)', () => {
	let app: INestApplication;
	let prisma: PrismaService;
	let cache: CacheService;
	let redis: Redis;
	let ownerToken: string;
	let memberToken: string;
	let viewerToken: string;
	let outsiderToken: string;
	let foreignOwnerToken: string;
	const cacheKeys = new Set<string>();
	const searchParams = new Map<string, { q: string; limit: number; offset: number }>();

	const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
	const listProjects = (token: string) =>
		request(app.getHttpServer()).get(`/workspaces/${ids.workspace}/projects`).set(auth(token));
	const searchDocuments = (token: string, q: string, limit = 20, offset = 0) => {
		searchParams.set(JSON.stringify({ q, limit, offset }), { q, limit, offset });
		return request(app.getHttpServer())
			.get(`/workspaces/${ids.workspace}/documents/search`)
			.set(auth(token))
			.query({ q, limit, offset });
	};
	const login = async (email: string) => {
		const response = await request(app.getHttpServer())
			.post('/auth/login')
			.send({ email, password })
			.expect(200);
		return response.body.accessToken as string;
	};
	const version = async () => {
		const value = await cache.getWorkspaceVersion(ids.workspace);
		if (value === null) throw new Error('Redis version is unavailable in the normal cache suite');
		return value;
	};
	const rememberProjectKey = async () => {
		const key = cache.projectsKey(ids.workspace, await version());
		cacheKeys.add(key);
		return key;
	};
	const rememberSearchKey = async (q: string, limit = 20, offset = 0) => {
		const params = { q, limit, offset };
		searchParams.set(JSON.stringify(params), params);
		const key = cache.searchKey(ids.workspace, await version(), params);
		cacheKeys.add(key);
		return key;
	};

	beforeAll(async () => {
		const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
		app = moduleFixture.createNestApplication();
		app.useGlobalPipes(createAppValidationPipe());
		await app.init();

		prisma = app.get(PrismaService);
		cache = app.get(CacheService);
		redis = app.get(REDIS_CLIENT);
		if (redis.status === 'wait') await redis.connect();

		const passwordHash = await bcrypt.hash(password, 4);
		const [owner, member, viewer, , foreignOwner] = await Promise.all(
			Object.entries(emails).map(([role, email]) =>
				prisma.user.create({
					data: { email, name: `Task 4 ${role}`, password: passwordHash },
				}),
			),
		);

		await prisma.workspace.create({
			data: {
				id: ids.workspace,
				name: 'Task 4 Workspace',
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
						name: 'Task 4 Cached Project',
						createdById: owner.id,
						documents: {
							create: {
								id: ids.document,
								title: 'Orchid quantum manual',
								content: 'private task4 content',
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
				name: 'Task 4 Foreign Workspace',
				members: { create: { userId: foreignOwner.id, role: WorkspaceRole.OWNER } },
				projects: {
					create: {
						id: ids.foreignProject,
						name: 'Task 4 Foreign Project',
						createdById: foreignOwner.id,
						documents: {
							create: {
								id: ids.foreignDocument,
								title: 'Orchid quantum manual',
								content: 'foreign private content',
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
		if (redis) {
			const versionKey = cache.workspaceVersionKey(ids.workspace);
			cacheKeys.add(versionKey);
			const currentVersion = Number((await redis.get(versionKey)) ?? '0');
			for (let value = 0; value <= currentVersion; value += 1) {
				const cacheVersion = String(value);
				cacheKeys.add(cache.projectsKey(ids.workspace, cacheVersion));
				for (const params of searchParams.values()) {
					cacheKeys.add(cache.searchKey(ids.workspace, cacheVersion, params));
				}
			}
			for (const key of cacheKeys) {
				await redis.del(key, `${key}:lock`);
			}
		}
		if (prisma) {
			await prisma.workspace.deleteMany({
				where: { id: { in: [ids.workspace, ids.foreignWorkspace] } },
			});
			await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
		}
		if (app) await app.close();
	});

	it('returns 401 before cache access when JWT is missing', async () => {
		const projectKey = await rememberProjectKey();
		const searchKey = await rememberSearchKey('Orchid quantum manual');

		await request(app.getHttpServer()).get(`/workspaces/${ids.workspace}/projects`).expect(401);
		await request(app.getHttpServer())
			.get(`/workspaces/${ids.workspace}/documents/search`)
			.query({ q: 'Orchid quantum manual' })
			.expect(401);

		expect(await redis.get(projectKey)).toBeNull();
		expect(await redis.get(searchKey)).toBeNull();
	});

	it('exports only CacheService from CacheModule', () => {
		const exportedProviders = Reflect.getMetadata('exports', CacheModule) as unknown[];
		expect(exportedProviders).toEqual([CacheService]);
	});

	it('keeps Redis GET failures separate from corrupted JSON cleanup', async () => {
		const key = await rememberProjectKey();
		const get = jest.spyOn(redis, 'get').mockRejectedValueOnce(new Error('synthetic GET failure'));
		const del = jest.spyOn(redis, 'del');

		try {
			await expect(
				cache.remember(key, cache.projectsTtlSeconds, async () => ['db']),
			).resolves.toEqual(['db']);
			expect(del).not.toHaveBeenCalled();
		} finally {
			get.mockRestore();
			del.mockRestore();
		}
	});

	it('deletes only corrupted JSON key and refills it from PostgreSQL', async () => {
		const key = await rememberProjectKey();
		const neighborKey = `${key}:neighbor`;
		cacheKeys.add(neighborKey);
		await redis.set(key, '{broken-json', 'EX', 60);
		await redis.set(neighborKey, 'keep-me', 'EX', 60);
		const del = jest.spyOn(redis, 'del');

		try {
			const response = await listProjects(ownerToken).expect(200);
			expect(response.body.map((project: { id: string }) => project.id)).toContain(ids.project);
			expect(del).toHaveBeenCalledWith(key);
			expect(await redis.get(neighborKey)).toBe('keep-me');
			const refilled = await redis.get(key);
			expect(() => JSON.parse(refilled ?? '')).not.toThrow();
		} finally {
			del.mockRestore();
		}
	});

	it('uses distinct tenant, version and canonical search keys', () => {
		const base = { q: 'Orchid quantum manual', limit: 20, offset: 0 };
		const keys = new Set([
			cache.searchKey(ids.workspace, '0', base),
			cache.searchKey(ids.foreignWorkspace, '0', base),
			cache.searchKey(ids.workspace, '1', base),
			cache.searchKey(ids.workspace, '0', { ...base, q: 'Nebula satellite protocol' }),
			cache.searchKey(ids.workspace, '0', { ...base, limit: 10 }),
			cache.searchKey(ids.workspace, '0', { ...base, offset: 10 }),
		]);

		expect(keys.size).toBe(6);
		for (const key of keys) expect(key).not.toContain(base.q);
	});

	it('keeps TTL jitter positive, integral and within ten percent', () => {
		const baseTtl = 100;
		expect(ttlWithJitter(baseTtl, () => 0)).toBe(90);
		expect(ttlWithJitter(baseTtl, () => 0.5)).toBe(100);
		expect(ttlWithJitter(baseTtl, () => 0.999999)).toBe(110);
		expect(ttlWithJitter(1, () => 0)).toBe(1);
		expect(baseTtl).toBe(100);
	});

	it('caches project list across read roles and invalidates it after HTTP update', async () => {
		const first = await listProjects(ownerToken).expect(200);
		expect(first.body).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: ids.project,
					name: 'Task 4 Cached Project',
					_count: { documents: 1 },
					createdBy: { name: 'Task 4 owner' },
				}),
			]),
		);

		const cachedVersion = await version();
		const key = await rememberProjectKey();
		expect(await redis.ttl(key)).toBeGreaterThan(0);

		await prisma.project.update({
			where: { id: ids.project },
			data: { name: 'Direct database probe' },
		});

		for (const token of [memberToken, viewerToken]) {
			const hit = await listProjects(token).expect(200);
			expect(hit.body.find((project: { id: string }) => project.id === ids.project).name).toBe(
				'Task 4 Cached Project',
			);
		}

		await request(app.getHttpServer())
			.patch(`/projects/${ids.project}`)
			.set(auth(memberToken))
			.send({ name: 'Task 4 Fresh Project' })
			.expect(200);

		expect(Number(await version())).toBe(Number(cachedVersion) + 1);
		const fresh = await listProjects(ownerToken).expect(200);
		expect(fresh.body.find((project: { id: string }) => project.id === ids.project).name).toBe(
			'Task 4 Fresh Project',
		);
	});

	it('caches search without leaking foreign data and invalidates after document update', async () => {
		const query = 'Orchid quantum manual';
		const first = await searchDocuments(ownerToken, query).expect(200);
		const firstIds = first.body.map((result: SearchResult) => result.id);
		expect(firstIds).toContain(ids.document);
		expect(firstIds).not.toContain(ids.foreignDocument);
		expect(Object.keys(first.body[0]).sort()).toEqual(
			['author', 'id', 'projectId', 'score', 'status', 'title', 'updatedAt'].sort(),
		);
		expect(first.body[0]).not.toHaveProperty('content');
		expect(first.body[0]).not.toHaveProperty('email');

		const cachedVersion = await version();
		const key = await rememberSearchKey(query);
		expect(await redis.ttl(key)).toBeGreaterThan(0);

		await prisma.document.update({
			where: { id: ids.document },
			data: { title: 'Copper river atlas' },
		});

		for (const token of [memberToken, viewerToken]) {
			const hit = await searchDocuments(token, query).expect(200);
			expect(hit.body.map((result: SearchResult) => result.id)).toContain(ids.document);
			expect(hit.body.map((result: SearchResult) => result.id)).not.toContain(ids.foreignDocument);
		}

		await request(app.getHttpServer())
			.patch(`/documents/${ids.document}`)
			.set(auth(memberToken))
			.send({ title: 'Nebula satellite protocol' })
			.expect(200);

		expect(Number(await version())).toBe(Number(cachedVersion) + 1);
		const staleQuery = await searchDocuments(ownerToken, query).expect(200);
		expect(staleQuery.body.map((result: SearchResult) => result.id)).not.toContain(ids.document);
		expect(staleQuery.body.map((result: SearchResult) => result.id)).not.toContain(
			ids.foreignDocument,
		);
		const freshQuery = await searchDocuments(ownerToken, 'Nebula satellite protocol').expect(200);
		expect(freshQuery.body.map((result: SearchResult) => result.id)).toContain(ids.document);
	});

	it('returns hidden 404 before Redis and keeps tenant isolation on miss and hit', async () => {
		const query = 'Isolation lighthouse signal';
		const key = await rememberSearchKey(query);
		expect(await redis.get(key)).toBeNull();

		await searchDocuments(outsiderToken, query).expect(404);
		expect(await redis.get(key)).toBeNull();

		const ownerId = await prisma.user.findUniqueOrThrow({ where: { email: emails.owner } });
		const foreignOwner = await prisma.user.findUniqueOrThrow({
			where: { email: emails.foreignOwner },
		});
		const localIsolationDocumentId = `${runId}-local-isolation`;
		const foreignIsolationDocumentId = `${runId}-foreign-isolation`;
		await prisma.document.createMany({
			data: [
				{
					id: localIsolationDocumentId,
					projectId: ids.project,
					authorId: ownerId.id,
					title: query,
					content: 'local',
				},
				{
					id: foreignIsolationDocumentId,
					projectId: ids.foreignProject,
					authorId: foreignOwner.id,
					title: query,
					content: 'foreign',
				},
			],
		});

		const miss = await searchDocuments(ownerToken, query).expect(200);
		const missIds = miss.body.map((result: SearchResult) => result.id);
		expect(missIds).toContain(localIsolationDocumentId);
		expect(missIds).not.toContain(foreignIsolationDocumentId);
		const hit = await searchDocuments(viewerToken, query).expect(200);
		const hitIds = hit.body.map((result: SearchResult) => result.id);
		expect(hitIds).toContain(localIsolationDocumentId);
		expect(hitIds).not.toContain(foreignIsolationDocumentId);
	});

	it('bumps workspace version after every project mutation', async () => {
		let previous = Number(await version());
		const created = await request(app.getHttpServer())
			.post(`/workspaces/${ids.workspace}/projects`)
			.set(auth(memberToken))
			.send({ name: 'Task 4 Mutation Project' })
			.expect(201);
		expect(Number(await version())).toBe(previous + 1);

		previous = Number(await version());
		await request(app.getHttpServer())
			.patch(`/projects/${created.body.id}`)
			.set(auth(memberToken))
			.send({ name: 'Task 4 Mutation Project Updated' })
			.expect(200);
		expect(Number(await version())).toBe(previous + 1);

		previous = Number(await version());
		await request(app.getHttpServer())
			.patch(`/projects/${created.body.id}/archive`)
			.set(auth(memberToken))
			.expect(200);
		expect(Number(await version())).toBe(previous + 1);

		previous = Number(await version());
		await request(app.getHttpServer())
			.delete(`/projects/${created.body.id}`)
			.set(auth(ownerToken))
			.expect(200);
		expect(Number(await version())).toBe(previous + 1);
	});

	it('does not change another workspace version after a local mutation', async () => {
		const localBefore = Number(await version());
		const foreignVersionKey = cache.workspaceVersionKey(ids.foreignWorkspace);
		cacheKeys.add(foreignVersionKey);
		const foreignBefore = Number((await redis.get(foreignVersionKey)) ?? '0');

		const created = await request(app.getHttpServer())
			.post(`/workspaces/${ids.workspace}/projects`)
			.set(auth(ownerToken))
			.send({ name: 'Task 4 Isolated Version Project' })
			.expect(201);

		expect(Number(await version())).toBe(localBefore + 1);
		expect(Number((await redis.get(foreignVersionKey)) ?? '0')).toBe(foreignBefore);

		await request(app.getHttpServer())
			.delete(`/projects/${created.body.id}`)
			.set(auth(ownerToken))
			.expect(200);
		await request(app.getHttpServer())
			.get(`/workspaces/${ids.foreignWorkspace}/projects`)
			.set(auth(foreignOwnerToken))
			.expect(200);
	});

	it('bumps workspace version after every document mutation', async () => {
		let previous = Number(await version());
		const created = await request(app.getHttpServer())
			.post(`/projects/${ids.project}/documents`)
			.set(auth(memberToken))
			.send({ title: 'Task 4 Mutation Document', content: '' })
			.expect(201);
		expect(Number(await version())).toBe(previous + 1);

		previous = Number(await version());
		await request(app.getHttpServer())
			.patch(`/documents/${created.body.id}`)
			.set(auth(memberToken))
			.send({ title: 'Task 4 Mutation Document Updated' })
			.expect(200);
		expect(Number(await version())).toBe(previous + 1);

		previous = Number(await version());
		await request(app.getHttpServer())
			.patch(`/documents/${created.body.id}/archive`)
			.set(auth(memberToken))
			.expect(200);
		expect(Number(await version())).toBe(previous + 1);

		previous = Number(await version());
		await request(app.getHttpServer())
			.delete(`/documents/${created.body.id}`)
			.set(auth(ownerToken))
			.expect(200);
		expect(Number(await version())).toBe(previous + 1);
	});

	it('coalesces concurrent project-list misses without mocking PostgreSQL', async () => {
		await cache.invalidateWorkspace(ids.workspace);
		const projectFindMany = jest.spyOn(prisma.project, 'findMany');

		try {
			await Promise.all(Array.from({ length: 8 }, () => listProjects(ownerToken).expect(200)));
			expect(projectFindMany).toHaveBeenCalledTimes(1);
		} finally {
			projectFindMany.mockRestore();
		}
	});

	it('closes a ready Redis client gracefully without leaving it open', async () => {
		const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
		const shutdownApp = moduleFixture.createNestApplication();
		await shutdownApp.init();
		const shutdownRedis = shutdownApp.get<Redis>(REDIS_CLIENT);
		if (shutdownRedis.status === 'wait') await shutdownRedis.connect();
		const quit = jest.spyOn(shutdownRedis, 'quit');

		await shutdownApp.close();

		expect(quit).toHaveBeenCalledTimes(1);
		expect(shutdownRedis.status).toBe('end');
	});

	it('falls back to disconnect when graceful Redis shutdown fails', async () => {
		const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
		const shutdownApp = moduleFixture.createNestApplication();
		await shutdownApp.init();
		const shutdownRedis = shutdownApp.get<Redis>(REDIS_CLIENT);
		if (shutdownRedis.status === 'wait') await shutdownRedis.connect();
		const quit = jest.spyOn(shutdownRedis, 'quit').mockRejectedValueOnce(new Error('quit failed'));
		const disconnect = jest.spyOn(shutdownRedis, 'disconnect');

		await shutdownApp.close();

		expect(quit).toHaveBeenCalledTimes(1);
		expect(disconnect).toHaveBeenCalledTimes(1);
		expect(shutdownRedis.status).toBe('end');
	});
});

describeWithoutRedis('Task 4 degraded mode with Redis stopped (e2e)', () => {
	let app: INestApplication;
	let prisma: PrismaService;
	let cache: CacheService;
	let redis: Redis;
	let ownerToken: string;
	let memberToken: string;
	let viewerToken: string;
	let outsiderToken: string;
	const degradedWorkspaceId = `${runId}-degraded-workspace`;
	const degradedProjectId = `${runId}-degraded-project`;
	const degradedDocumentId = `${runId}-degraded-document`;

	const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
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
		cache = app.get(CacheService);
		redis = app.get(REDIS_CLIENT);

		const passwordHash = await bcrypt.hash(password, 4);
		const [owner, member, viewer, , foreignOwner] = await Promise.all([
			prisma.user.create({
				data: { email: emails.owner, name: 'Task 4 owner', password: passwordHash },
			}),
			prisma.user.create({
				data: { email: emails.member, name: 'Task 4 member', password: passwordHash },
			}),
			prisma.user.create({
				data: { email: emails.viewer, name: 'Task 4 viewer', password: passwordHash },
			}),
			prisma.user.create({
				data: { email: emails.outsider, name: 'Task 4 outsider', password: passwordHash },
			}),
			prisma.user.create({
				data: {
					email: emails.foreignOwner,
					name: 'Task 4 foreign owner',
					password: passwordHash,
				},
			}),
		]);

		await prisma.workspace.create({
			data: {
				id: degradedWorkspaceId,
				name: 'Task 4 Degraded Workspace',
				members: {
					create: [
						{ userId: owner.id, role: WorkspaceRole.OWNER },
						{ userId: member.id, role: WorkspaceRole.MEMBER },
						{ userId: viewer.id, role: WorkspaceRole.VIEWER },
					],
				},
				projects: {
					create: {
						id: degradedProjectId,
						name: 'Task 4 Degraded Project',
						createdById: owner.id,
						documents: {
							create: {
								id: degradedDocumentId,
								title: 'Degraded redis search',
								content: '',
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
				name: 'Task 4 Degraded Foreign Workspace',
				members: { create: { userId: foreignOwner.id, role: WorkspaceRole.OWNER } },
				projects: {
					create: {
						id: ids.foreignProject,
						name: 'Task 4 Degraded Foreign Project',
						createdById: foreignOwner.id,
						documents: {
							create: {
								id: ids.foreignDocument,
								title: 'Degraded redis search',
								content: 'foreign private content',
								authorId: foreignOwner.id,
							},
						},
					},
				},
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
		if (prisma) {
			await prisma.workspace.deleteMany({
				where: { id: { in: [degradedWorkspaceId, ids.foreignWorkspace] } },
			});
			await prisma.user.deleteMany({
				where: { email: { in: Object.values(emails) } },
			});
		}
		if (app) await app.close();
	});

	it('preserves authorization and reads through PostgreSQL while Redis is unavailable', async () => {
		const connect = jest.spyOn(redis, 'connect');
		const versions = await Promise.all(
			Array.from({ length: 8 }, () => cache.getWorkspaceVersion(degradedWorkspaceId)),
		);
		expect(versions).toEqual(Array(8).fill(null));
		expect(connect).toHaveBeenCalledTimes(1);

		await request(app.getHttpServer())
			.get(`/workspaces/${degradedWorkspaceId}/projects`)
			.expect(401);
		await request(app.getHttpServer())
			.get(`/workspaces/${degradedWorkspaceId}/documents/search`)
			.query({ q: 'Degraded redis search' })
			.expect(401);

		for (const token of [ownerToken, memberToken, viewerToken]) {
			await request(app.getHttpServer())
				.get(`/workspaces/${degradedWorkspaceId}/projects`)
				.set(auth(token))
				.expect(200)
				.expect((response) => {
					const projectIds = response.body.map((project: { id: string }) => project.id);
					expect(projectIds).toContain(degradedProjectId);
					expect(projectIds).not.toContain(ids.foreignProject);
				});

			await request(app.getHttpServer())
				.get(`/workspaces/${degradedWorkspaceId}/documents/search`)
				.set(auth(token))
				.query({ q: 'Degraded redis search' })
				.expect(200)
				.expect((response) => {
					const documentIds = response.body.map((document: { id: string }) => document.id);
					expect(documentIds).toContain(degradedDocumentId);
					expect(documentIds).not.toContain(ids.foreignDocument);
					expect(response.body[0]).not.toHaveProperty('content');
					expect(response.body[0]).not.toHaveProperty('email');
				});
		}

		await request(app.getHttpServer())
			.get(`/workspaces/${degradedWorkspaceId}/projects`)
			.set(auth(outsiderToken))
			.expect(404);
		await request(app.getHttpServer())
			.get(`/workspaces/${degradedWorkspaceId}/documents/search`)
			.set(auth(outsiderToken))
			.query({ q: 'Degraded redis search' })
			.expect(404);
		expect(connect).toHaveBeenCalledTimes(1);
	});
});
