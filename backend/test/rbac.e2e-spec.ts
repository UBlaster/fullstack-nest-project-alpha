import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createAppValidationPipe } from '../src/validation.pipe';

const password = 'password123';
const workspaceA = 'seed-workspace-1';
const workspaceB = 'seed-workspace-2';
const projectA = 'seed-project-0-1';
const projectB = 'seed-project-1-1';
const documentA = 'seed-document-0-1-0';
const documentB = 'seed-document-1-1-0';

describe('RBAC (e2e)', () => {
	let app: INestApplication;
	let prisma: PrismaService;
	let adminToken: string;
	let memberToken: string;
	let viewerToken: string;
	let outsiderToken: string;
	const createdWorkspaceIds: string[] = [];
	const createdProjectIds: string[] = [];
	const createdDocumentIds: string[] = [];

	const auth = (token: string) => ({
		Authorization: `Bearer ${token}`,
	});

	const login = async (email: string) => {
		const res = await request(app.getHttpServer())
			.post('/auth/login')
			.send({
				email,
				password,
			})
			.expect(200);

		return res.body.accessToken as string;
	};

	beforeAll(async () => {
		const moduleFixture = await Test.createTestingModule({
			imports: [AppModule],
		}).compile();

		app = moduleFixture.createNestApplication();
		app.useGlobalPipes(createAppValidationPipe());
		await app.init();

		prisma = app.get(PrismaService);
		adminToken = await login('admin@example.com');
		memberToken = await login('member@example.com');
		viewerToken = await login('viewer@example.com');
		outsiderToken = await login('other@example.com');
	});

	afterAll(async () => {
		if (createdDocumentIds.length) {
			await prisma.document.deleteMany({
				where: {
					id: {
						in: createdDocumentIds,
					},
				},
			});
		}

		if (createdProjectIds.length) {
			await prisma.project.deleteMany({
				where: {
					id: {
						in: createdProjectIds,
					},
				},
			});
		}

		if (createdWorkspaceIds.length) {
			await prisma.workspace.deleteMany({
				where: {
					id: {
						in: createdWorkspaceIds,
					},
				},
			});
		}

		await prisma.$disconnect();
		await app.close();
	});

	describe('401', () => {
		it('rejects protected routes without a token', async () => {
			await request(app.getHttpServer()).get('/workspaces').expect(401);
			await request(app.getHttpServer()).post('/workspaces').send({ name: 'X' }).expect(401);
			await request(app.getHttpServer()).get('/projects').expect(401);
			await request(app.getHttpServer()).get(`/projects/${projectA}`).expect(401);
			await request(app.getHttpServer()).get(`/documents/${documentA}`).expect(401);
		});

		it('rejects protected routes with a garbage JWT', async () => {
			await request(app.getHttpServer()).get('/workspaces').set(auth('not-a-jwt')).expect(401);
		});
	});

	describe('outsider', () => {
		it('returns empty lists', async () => {
			const workspaces = await request(app.getHttpServer())
				.get('/workspaces')
				.set(auth(outsiderToken))
				.expect(200);
			const projects = await request(app.getHttpServer())
				.get('/projects')
				.set(auth(outsiderToken))
				.expect(200);

			expect(workspaces.body).toEqual([]);
			expect(projects.body).toEqual([]);
		});

		it('returns 404 for foreign workspace, project and document', async () => {
			await request(app.getHttpServer())
				.get(`/workspaces/${workspaceA}`)
				.set(auth(outsiderToken))
				.expect(404);
			await request(app.getHttpServer())
				.patch(`/workspaces/${workspaceA}`)
				.set(auth(outsiderToken))
				.send({ name: 'Hijack' })
				.expect(404);
			await request(app.getHttpServer())
				.delete(`/workspaces/${workspaceA}`)
				.set(auth(outsiderToken))
				.expect(404);
			await request(app.getHttpServer())
				.get(`/workspaces/${workspaceA}/projects`)
				.set(auth(outsiderToken))
				.expect(404);
			await request(app.getHttpServer())
				.get(`/projects/${projectA}`)
				.set(auth(outsiderToken))
				.expect(404);
			await request(app.getHttpServer())
				.patch(`/projects/${projectA}`)
				.set(auth(outsiderToken))
				.send({ name: 'Hijack' })
				.expect(404);
			await request(app.getHttpServer())
				.delete(`/projects/${projectA}`)
				.set(auth(outsiderToken))
				.expect(404);
			await request(app.getHttpServer())
				.get(`/documents/${documentA}`)
				.set(auth(outsiderToken))
				.expect(404);
			await request(app.getHttpServer())
				.patch(`/documents/${documentA}`)
				.set(auth(outsiderToken))
				.send({ title: 'Hijack' })
				.expect(404);
			await request(app.getHttpServer())
				.delete(`/documents/${documentA}`)
				.set(auth(outsiderToken))
				.expect(404);
		});
	});

	describe('VIEWER in workspace B', () => {
		it('can view workspace, project and document', async () => {
			await request(app.getHttpServer())
				.get(`/workspaces/${workspaceB}`)
				.set(auth(viewerToken))
				.expect(200);
			await request(app.getHttpServer())
				.get(`/projects/${projectB}`)
				.set(auth(viewerToken))
				.expect(200);
			await request(app.getHttpServer())
				.get(`/documents/${documentB}`)
				.set(auth(viewerToken))
				.expect(200);
		});

		it('cannot create, update, archive or delete', async () => {
			await request(app.getHttpServer())
				.post(`/workspaces/${workspaceB}/projects`)
				.set(auth(viewerToken))
				.send({ name: 'Viewer project' })
				.expect(403);
			await request(app.getHttpServer())
				.post(`/projects/${projectB}/documents`)
				.set(auth(viewerToken))
				.send({ title: 'Viewer doc', content: 'no' })
				.expect(403);
			await request(app.getHttpServer())
				.patch(`/projects/${projectB}`)
				.set(auth(viewerToken))
				.send({ name: 'Nope' })
				.expect(403);
			await request(app.getHttpServer())
				.patch(`/projects/${projectB}/archive`)
				.set(auth(viewerToken))
				.expect(403);
			await request(app.getHttpServer())
				.delete(`/projects/${projectB}`)
				.set(auth(viewerToken))
				.expect(403);
			await request(app.getHttpServer())
				.patch(`/documents/${documentB}`)
				.set(auth(viewerToken))
				.send({ title: 'Nope' })
				.expect(403);
			await request(app.getHttpServer())
				.patch(`/documents/${documentB}/archive`)
				.set(auth(viewerToken))
				.expect(403);
			await request(app.getHttpServer())
				.delete(`/documents/${documentB}`)
				.set(auth(viewerToken))
				.expect(403);
			await request(app.getHttpServer())
				.patch(`/workspaces/${workspaceB}`)
				.set(auth(viewerToken))
				.send({ name: 'Nope' })
				.expect(403);
			await request(app.getHttpServer())
				.patch(`/workspaces/${workspaceB}/archive`)
				.set(auth(viewerToken))
				.expect(403);
			await request(app.getHttpServer())
				.delete(`/workspaces/${workspaceB}`)
				.set(auth(viewerToken))
				.expect(403);
		});
	});

	describe('MEMBER in workspace A', () => {
		it('can create and update project and document, but cannot delete them or archive workspace', async () => {
			const projectRes = await request(app.getHttpServer())
				.post(`/workspaces/${workspaceA}/projects`)
				.set(auth(viewerToken))
				.send({
					name: 'Member project',
					description: 'created by MEMBER',
				})
				.expect(201);
			createdProjectIds.push(projectRes.body.id);

			await request(app.getHttpServer())
				.patch(`/projects/${projectRes.body.id}`)
				.set(auth(viewerToken))
				.send({ name: 'Member project updated' })
				.expect(200);

			const documentRes = await request(app.getHttpServer())
				.post(`/projects/${projectRes.body.id}/documents`)
				.set(auth(viewerToken))
				.send({
					title: 'Member document',
					content: 'body',
					status: 'DRAFT',
				})
				.expect(201);
			createdDocumentIds.push(documentRes.body.id);

			await request(app.getHttpServer())
				.patch(`/documents/${documentRes.body.id}`)
				.set(auth(viewerToken))
				.send({
					title: 'Member document updated',
					content: 'body 2',
				})
				.expect(200);

			await request(app.getHttpServer())
				.delete(`/projects/${projectRes.body.id}`)
				.set(auth(viewerToken))
				.expect(403);
			await request(app.getHttpServer())
				.delete(`/documents/${documentRes.body.id}`)
				.set(auth(viewerToken))
				.expect(403);
			await request(app.getHttpServer())
				.patch(`/workspaces/${workspaceA}/archive`)
				.set(auth(viewerToken))
				.expect(403);
			await request(app.getHttpServer())
				.delete(`/workspaces/${workspaceA}`)
				.set(auth(viewerToken))
				.expect(403);
		});
	});

	describe('ADMIN in workspace A', () => {
		it('can archive and delete project and document, but cannot archive workspace', async () => {
			const projectRes = await request(app.getHttpServer())
				.post(`/workspaces/${workspaceA}/projects`)
				.set(auth(memberToken))
				.send({ name: 'Admin project' })
				.expect(201);
			createdProjectIds.push(projectRes.body.id);

			const documentRes = await request(app.getHttpServer())
				.post(`/projects/${projectRes.body.id}/documents`)
				.set(auth(memberToken))
				.send({
					title: 'Admin document',
					content: 'body',
				})
				.expect(201);
			createdDocumentIds.push(documentRes.body.id);

			await request(app.getHttpServer())
				.patch(`/projects/${projectRes.body.id}/archive`)
				.set(auth(memberToken))
				.expect(200)
				.expect((res) => {
					expect(res.body.status).toBe('ARCHIVED');
				});
			await request(app.getHttpServer())
				.patch(`/documents/${documentRes.body.id}/archive`)
				.set(auth(memberToken))
				.expect(200)
				.expect((res) => {
					expect(res.body.status).toBe('ARCHIVED');
				});
			await request(app.getHttpServer())
				.delete(`/documents/${documentRes.body.id}`)
				.set(auth(memberToken))
				.expect(200);
			createdDocumentIds.splice(createdDocumentIds.indexOf(documentRes.body.id), 1);
			await request(app.getHttpServer())
				.delete(`/projects/${projectRes.body.id}`)
				.set(auth(memberToken))
				.expect(200);
			createdProjectIds.splice(createdProjectIds.indexOf(projectRes.body.id), 1);

			await request(app.getHttpServer())
				.patch(`/workspaces/${workspaceA}/archive`)
				.set(auth(memberToken))
				.expect(403);
			await request(app.getHttpServer())
				.delete(`/workspaces/${workspaceA}`)
				.set(auth(memberToken))
				.expect(403);
		});
	});

	describe('OWNER', () => {
		it('creates a workspace as OWNER and can update, archive and delete it', async () => {
			const createRes = await request(app.getHttpServer())
				.post('/workspaces')
				.set(auth(adminToken))
				.send({ name: 'Owner workspace' })
				.expect(201);
			createdWorkspaceIds.push(createRes.body.id);

			const listRes = await request(app.getHttpServer())
				.get('/workspaces')
				.set(auth(adminToken))
				.expect(200);
			expect(
				listRes.body.some((workspace: { id: string }) => workspace.id === createRes.body.id),
			).toBe(true);

			await request(app.getHttpServer())
				.patch(`/workspaces/${createRes.body.id}`)
				.set(auth(adminToken))
				.send({ name: 'Owner workspace renamed' })
				.expect(200)
				.expect((res) => {
					expect(res.body.name).toBe('Owner workspace renamed');
				});

			await request(app.getHttpServer())
				.patch(`/workspaces/${createRes.body.id}/archive`)
				.set(auth(adminToken))
				.expect(200)
				.expect((res) => {
					expect(res.body.status).toBe('ARCHIVED');
				});

			await request(app.getHttpServer())
				.delete(`/workspaces/${createRes.body.id}`)
				.set(auth(adminToken))
				.expect(200);
			createdWorkspaceIds.splice(createdWorkspaceIds.indexOf(createRes.body.id), 1);

			await request(app.getHttpServer())
				.get(`/workspaces/${createRes.body.id}`)
				.set(auth(adminToken))
				.expect(404);
		});
	});

	describe('list isolation', () => {
		it('returns only projects of the requested workspace', async () => {
			const res = await request(app.getHttpServer())
				.get(`/workspaces/${workspaceA}/projects`)
				.set(auth(adminToken))
				.expect(200);

			expect(res.body.length).toBeGreaterThan(0);
			expect(
				res.body.every((project: { workspaceId: string }) => project.workspaceId === workspaceA),
			).toBe(true);
			expect(res.body.some((project: { id: string }) => project.id === projectB)).toBe(false);
		});

		it('does not include foreign projects in GET /projects', async () => {
			const res = await request(app.getHttpServer())
				.get('/projects')
				.set(auth(adminToken))
				.expect(200);

			expect(res.body.some((project: { id: string }) => project.id === projectA)).toBe(true);
			expect(res.body.every((project: { workspaceId: string }) => project.workspaceId)).toBe(true);
		});
	});

	describe('archive vs update', () => {
		it('ignores status on PATCH and archives only through the archive endpoint', async () => {
			const projectRes = await request(app.getHttpServer())
				.post(`/workspaces/${workspaceA}/projects`)
				.set(auth(adminToken))
				.send({ name: 'Archive probe' })
				.expect(201);
			createdProjectIds.push(projectRes.body.id);
			expect(projectRes.body.status).toBe('ACTIVE');

			const patched = await request(app.getHttpServer())
				.patch(`/projects/${projectRes.body.id}`)
				.set(auth(adminToken))
				.send({
					name: 'Archive probe',
					status: 'ARCHIVED',
				})
				.expect(200);
			expect(patched.body.status).toBe('ACTIVE');
			expect(patched.body.name).toBe('Archive probe');

			const archived = await request(app.getHttpServer())
				.patch(`/projects/${projectRes.body.id}/archive`)
				.set(auth(adminToken))
				.expect(200);
			expect(archived.body.status).toBe('ARCHIVED');
		});
	});

	describe('DTO scope', () => {
		it('creates a project in the URL workspace even if body sends another workspaceId', async () => {
			const res = await request(app.getHttpServer())
				.post(`/workspaces/${workspaceA}/projects`)
				.set(auth(adminToken))
				.send({
					name: 'Scoped project',
					workspaceId: workspaceB,
					createdById: 'not-the-caller',
				})
				.expect(201);
			createdProjectIds.push(res.body.id);
			expect(res.body.workspaceId).toBe(workspaceA);
		});

		it('creates a document in the URL project even if body sends another projectId', async () => {
			const res = await request(app.getHttpServer())
				.post(`/projects/${projectA}/documents`)
				.set(auth(adminToken))
				.send({
					title: 'Scoped document',
					content: 'body',
					projectId: projectB,
					authorId: 'not-the-caller',
				})
				.expect(201);
			createdDocumentIds.push(res.body.id);
			expect(res.body.projectId).toBe(projectA);
		});
	});

	describe('legacy frontend paths', () => {
		it('keeps GET /projects, GET /projects/:id, create and patch documents working', async () => {
			const listRes = await request(app.getHttpServer())
				.get('/projects')
				.set(auth(adminToken))
				.expect(200);
			expect(Array.isArray(listRes.body)).toBe(true);

			await request(app.getHttpServer())
				.get(`/projects/${projectA}`)
				.set(auth(adminToken))
				.expect(200);

			const created = await request(app.getHttpServer())
				.post(`/projects/${projectA}/documents`)
				.set(auth(adminToken))
				.send({
					title: 'Frontend document',
					content: 'from ui',
					status: 'DRAFT',
				})
				.expect(201);
			createdDocumentIds.push(created.body.id);

			await request(app.getHttpServer())
				.patch(`/documents/${created.body.id}`)
				.set(auth(adminToken))
				.send({
					title: 'Frontend document saved',
					content: 'from ui saved',
				})
				.expect(200);
		});
	});
});
