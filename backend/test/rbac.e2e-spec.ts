import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WorkspaceRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createAppValidationPipe } from '../src/validation.pipe';

const password = 'password123';
const workspaceId = 'task2-e2e-workspace';
const foreignWorkspaceId = 'task2-e2e-foreign-workspace';
const projectId = 'task2-e2e-project';
const foreignProjectId = 'task2-e2e-foreign-project';
const documentId = 'task2-e2e-document';
const foreignDocumentId = 'task2-e2e-foreign-document';

const emails = {
	owner: 'task2-owner@example.com',
	member: 'task2-member@example.com',
	viewer: 'task2-viewer@example.com',
	outsider: 'task2-outsider@example.com',
	foreignOwner: 'task2-foreign-owner@example.com',
};

describe('Task 2 RBAC and workspace isolation (e2e)', () => {
	let app: INestApplication;
	let prisma: PrismaService;
	let ownerId: string;
	let memberId: string;
	let outsiderId: string;
	let ownerToken: string;
	let memberToken: string;
	let viewerToken: string;
	let outsiderToken: string;

	const createdWorkspaceIds: string[] = [];

	const auth = (token: string) => ({
		Authorization: 'Bearer ' + token,
	});

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
		const owner = await prisma.user.create({
			data: { email: emails.owner, name: 'Task 2 Owner', password: passwordHash },
		});
		const member = await prisma.user.create({
			data: { email: emails.member, name: 'Task 2 Member', password: passwordHash },
		});
		const viewer = await prisma.user.create({
			data: { email: emails.viewer, name: 'Task 2 Viewer', password: passwordHash },
		});
		const outsider = await prisma.user.create({
			data: { email: emails.outsider, name: 'Task 2 Outsider', password: passwordHash },
		});
		const foreignOwner = await prisma.user.create({
			data: {
				email: emails.foreignOwner,
				name: 'Task 2 Foreign Owner',
				password: passwordHash,
			},
		});

		ownerId = owner.id;
		memberId = member.id;
		outsiderId = outsider.id;

		await prisma.workspace.create({
			data: {
				id: workspaceId,
				name: 'Task 2 Workspace',
				members: {
					create: [
						{ userId: owner.id, role: WorkspaceRole.OWNER },
						{ userId: member.id, role: WorkspaceRole.MEMBER },
						{ userId: viewer.id, role: WorkspaceRole.VIEWER },
					],
				},
				projects: {
					create: {
						id: projectId,
						name: 'Task 2 Project',
						description: 'Primary fixture',
						createdById: owner.id,
						documents: {
							create: {
								id: documentId,
								title: 'Task 2 Document',
								content: 'Primary document',
								authorId: owner.id,
							},
						},
					},
				},
			},
		});

		await prisma.workspace.create({
			data: {
				id: foreignWorkspaceId,
				name: 'Foreign Workspace',
				members: {
					create: { userId: foreignOwner.id, role: WorkspaceRole.OWNER },
				},
				projects: {
					create: {
						id: foreignProjectId,
						name: 'Foreign Project',
						createdById: foreignOwner.id,
						documents: {
							create: {
								id: foreignDocumentId,
								title: 'Foreign Document',
								content: 'Foreign document',
								authorId: foreignOwner.id,
							},
						},
					},
				},
			},
		});

		ownerToken = await login(emails.owner);
		memberToken = await login(emails.member);
		viewerToken = await login(emails.viewer);
		outsiderToken = await login(emails.outsider);
	});

	afterAll(async () => {
		await prisma.workspace.deleteMany({
			where: {
				id: {
					in: [workspaceId, foreignWorkspaceId, ...createdWorkspaceIds],
				},
			},
		});
		await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
		await app.close();
	});

	it('returns 401 for protected workspace, project and document routes without JWT', async () => {
		await request(app.getHttpServer()).get('/workspaces').expect(401);
		await request(app.getHttpServer()).get('/projects').expect(401);
		await request(app.getHttpServer())
			.get('/projects/' + projectId)
			.expect(401);
		await request(app.getHttpServer())
			.get('/documents/' + documentId)
			.expect(401);
	});

	it('creates a workspace with an OWNER membership and supports idempotent archive', async () => {
		const created = await request(app.getHttpServer())
			.post('/workspaces')
			.set(auth(memberToken))
			.send({ name: '  Personal Workspace  ' })
			.expect(201);
		createdWorkspaceIds.push(created.body.id);

		expect(created.body).toMatchObject({
			name: 'Personal Workspace',
			status: 'ACTIVE',
		});

		const membership = await prisma.workspaceMember.findUniqueOrThrow({
			where: {
				userId_workspaceId: {
					userId: memberId,
					workspaceId: created.body.id,
				},
			},
		});
		expect(membership.role).toBe(WorkspaceRole.OWNER);

		await request(app.getHttpServer())
			.patch('/workspaces/' + created.body.id)
			.set(auth(memberToken))
			.send({ name: 'Renamed Workspace', status: 'ARCHIVED' })
			.expect(200)
			.expect((response) => expect(response.body.status).toBe('ACTIVE'));

		await request(app.getHttpServer())
			.patch('/workspaces/' + created.body.id + '/archive')
			.set(auth(memberToken))
			.expect(200)
			.expect((response) => expect(response.body.status).toBe('ARCHIVED'));

		await request(app.getHttpServer())
			.patch('/workspaces/' + created.body.id + '/archive')
			.set(auth(memberToken))
			.expect(200)
			.expect((response) => expect(response.body.status).toBe('ARCHIVED'));

		await request(app.getHttpServer())
			.get('/workspaces/' + created.body.id)
			.set(auth(memberToken))
			.expect(200);

		await request(app.getHttpServer())
			.delete('/workspaces/' + created.body.id)
			.set(auth(memberToken))
			.expect(200);
		createdWorkspaceIds.splice(createdWorkspaceIds.indexOf(created.body.id), 1);

		await request(app.getHttpServer())
			.get('/workspaces/' + created.body.id)
			.set(auth(memberToken))
			.expect(404);
	});

	it('allows VIEWER to read but returns 403 for every mutation family', async () => {
		await request(app.getHttpServer())
			.get('/workspaces/' + workspaceId)
			.set(auth(viewerToken))
			.expect(200);
		await request(app.getHttpServer())
			.get('/projects/' + projectId)
			.set(auth(viewerToken))
			.expect(200);
		await request(app.getHttpServer())
			.get('/documents/' + documentId)
			.set(auth(viewerToken))
			.expect(200);

		await request(app.getHttpServer())
			.patch('/workspaces/' + workspaceId)
			.set(auth(viewerToken))
			.send({ name: 'Denied' })
			.expect(403);
		await request(app.getHttpServer())
			.patch('/workspaces/' + workspaceId + '/archive')
			.set(auth(viewerToken))
			.expect(403);
		await request(app.getHttpServer())
			.delete('/workspaces/' + workspaceId)
			.set(auth(viewerToken))
			.expect(403);
		await request(app.getHttpServer())
			.post('/workspaces/' + workspaceId + '/projects')
			.set(auth(viewerToken))
			.send({ name: 'Denied' })
			.expect(403);
		await request(app.getHttpServer())
			.patch('/projects/' + projectId)
			.set(auth(viewerToken))
			.send({ name: 'Denied' })
			.expect(403);
		await request(app.getHttpServer())
			.patch('/projects/' + projectId + '/archive')
			.set(auth(viewerToken))
			.expect(403);
		await request(app.getHttpServer())
			.delete('/projects/' + projectId)
			.set(auth(viewerToken))
			.expect(403);
		await request(app.getHttpServer())
			.post('/projects/' + projectId + '/documents')
			.set(auth(viewerToken))
			.send({ title: 'Denied', content: '' })
			.expect(403);
		await request(app.getHttpServer())
			.patch('/documents/' + documentId)
			.set(auth(viewerToken))
			.send({ title: 'Denied' })
			.expect(403);
		await request(app.getHttpServer())
			.patch('/documents/' + documentId + '/archive')
			.set(auth(viewerToken))
			.expect(403);
		await request(app.getHttpServer())
			.delete('/documents/' + documentId)
			.set(auth(viewerToken))
			.expect(403);
	});

	it('allows MEMBER to create, update and archive children but not manage workspace or delete children', async () => {
		const project = await request(app.getHttpServer())
			.post('/workspaces/' + workspaceId + '/projects')
			.set(auth(memberToken))
			.send({ name: 'Member Project', description: 'Created by member' })
			.expect(201);

		await request(app.getHttpServer())
			.patch('/projects/' + project.body.id)
			.set(auth(memberToken))
			.send({ name: 'Member Project Updated' })
			.expect(200);

		const document = await request(app.getHttpServer())
			.post('/projects/' + project.body.id + '/documents')
			.set(auth(memberToken))
			.send({ title: 'Member Document', content: '' })
			.expect(201);

		await request(app.getHttpServer())
			.patch('/documents/' + document.body.id)
			.set(auth(memberToken))
			.send({ content: 'Updated' })
			.expect(200);

		await request(app.getHttpServer())
			.patch('/projects/' + project.body.id + '/archive')
			.set(auth(memberToken))
			.expect(200);
		await request(app.getHttpServer())
			.patch('/documents/' + document.body.id + '/archive')
			.set(auth(memberToken))
			.expect(200);

		await request(app.getHttpServer())
			.patch('/workspaces/' + workspaceId)
			.set(auth(memberToken))
			.send({ name: 'Denied' })
			.expect(403);
		await request(app.getHttpServer())
			.patch('/workspaces/' + workspaceId + '/archive')
			.set(auth(memberToken))
			.expect(403);
		await request(app.getHttpServer())
			.delete('/workspaces/' + workspaceId)
			.set(auth(memberToken))
			.expect(403);
		await request(app.getHttpServer())
			.delete('/projects/' + project.body.id)
			.set(auth(memberToken))
			.expect(403);
		await request(app.getHttpServer())
			.delete('/documents/' + document.body.id)
			.set(auth(memberToken))
			.expect(403);
	});

	it('returns hidden 404 for outsider across resources and mutations', async () => {
		await request(app.getHttpServer())
			.get('/workspaces/' + workspaceId)
			.set(auth(outsiderToken))
			.expect(404);
		await request(app.getHttpServer())
			.get('/workspaces/' + workspaceId + '/projects')
			.set(auth(outsiderToken))
			.expect(404);
		await request(app.getHttpServer())
			.get('/projects/' + projectId)
			.set(auth(outsiderToken))
			.expect(404);
		await request(app.getHttpServer())
			.get('/projects/' + projectId + '/documents')
			.set(auth(outsiderToken))
			.expect(404);
		await request(app.getHttpServer())
			.get('/documents/' + documentId)
			.set(auth(outsiderToken))
			.expect(404);
		await request(app.getHttpServer())
			.patch('/workspaces/' + workspaceId)
			.set(auth(outsiderToken))
			.send({ name: 'Hidden' })
			.expect(404);
		await request(app.getHttpServer())
			.patch('/workspaces/' + workspaceId + '/archive')
			.set(auth(outsiderToken))
			.expect(404);
		await request(app.getHttpServer())
			.delete('/workspaces/' + workspaceId)
			.set(auth(outsiderToken))
			.expect(404);
		await request(app.getHttpServer())
			.post('/workspaces/' + workspaceId + '/projects')
			.set(auth(outsiderToken))
			.send({ name: 'Hidden' })
			.expect(404);
		await request(app.getHttpServer())
			.patch('/projects/' + projectId)
			.set(auth(outsiderToken))
			.send({ name: 'Hidden' })
			.expect(404);
		await request(app.getHttpServer())
			.patch('/projects/' + projectId + '/archive')
			.set(auth(outsiderToken))
			.expect(404);
		await request(app.getHttpServer())
			.delete('/projects/' + projectId)
			.set(auth(outsiderToken))
			.expect(404);
		await request(app.getHttpServer())
			.post('/projects/' + projectId + '/documents')
			.set(auth(outsiderToken))
			.send({ title: 'Hidden', content: '' })
			.expect(404);
		await request(app.getHttpServer())
			.patch('/documents/' + documentId)
			.set(auth(outsiderToken))
			.send({ title: 'Hidden' })
			.expect(404);
		await request(app.getHttpServer())
			.patch('/documents/' + documentId + '/archive')
			.set(auth(outsiderToken))
			.expect(404);
		await request(app.getHttpServer())
			.delete('/documents/' + documentId)
			.set(auth(outsiderToken))
			.expect(404);
	});

	it('isolates global and nested lists at the Prisma query level', async () => {
		const workspaces = await request(app.getHttpServer())
			.get('/workspaces')
			.set(auth(ownerToken))
			.expect(200);
		expect(workspaces.body.some((workspace: { id: string }) => workspace.id === workspaceId)).toBe(
			true,
		);
		expect(
			workspaces.body.some((workspace: { id: string }) => workspace.id === foreignWorkspaceId),
		).toBe(false);

		const projects = await request(app.getHttpServer())
			.get('/projects')
			.set(auth(ownerToken))
			.expect(200);
		expect(projects.body.some((project: { id: string }) => project.id === projectId)).toBe(true);
		expect(projects.body.some((project: { id: string }) => project.id === foreignProjectId)).toBe(
			false,
		);

		const nested = await request(app.getHttpServer())
			.get('/workspaces/' + workspaceId + '/projects')
			.set(auth(ownerToken))
			.expect(200);
		expect(
			nested.body.every((project: { workspaceId: string }) => project.workspaceId === workspaceId),
		).toBe(true);

		const outsiderWorkspaces = await request(app.getHttpServer())
			.get('/workspaces')
			.set(auth(outsiderToken))
			.expect(200);
		const outsiderProjects = await request(app.getHttpServer())
			.get('/projects')
			.set(auth(outsiderToken))
			.expect(200);
		expect(outsiderWorkspaces.body).toEqual([]);
		expect(outsiderProjects.body).toEqual([]);
	});

	it('ignores relation and status fields from body and uses URL/JWT context', async () => {
		const project = await request(app.getHttpServer())
			.post('/workspaces/' + workspaceId + '/projects')
			.set(auth(ownerToken))
			.send({
				name: 'Scoped Project',
				workspaceId: foreignWorkspaceId,
				createdById: outsiderId,
				status: 'ARCHIVED',
			})
			.expect(201);
		expect(project.body).toMatchObject({
			workspaceId,
			createdById: ownerId,
			status: 'ACTIVE',
		});

		const document = await request(app.getHttpServer())
			.post('/projects/' + project.body.id + '/documents')
			.set(auth(ownerToken))
			.send({
				title: 'Scoped Document',
				content: 'Body',
				projectId: foreignProjectId,
				authorId: outsiderId,
				status: 'ARCHIVED',
			})
			.expect(201);
		expect(document.body).toMatchObject({
			projectId: project.body.id,
			authorId: ownerId,
			status: 'DRAFT',
		});

		const projectUpdated = await request(app.getHttpServer())
			.patch('/projects/' + project.body.id)
			.set(auth(ownerToken))
			.send({ name: 'Still Active', status: 'ARCHIVED' })
			.expect(200);
		expect(projectUpdated.body.status).toBe('ACTIVE');

		const updated = await request(app.getHttpServer())
			.patch('/documents/' + document.body.id)
			.set(auth(ownerToken))
			.send({
				title: 'Still Scoped',
				projectId: foreignProjectId,
				authorId: outsiderId,
				status: 'ARCHIVED',
			})
			.expect(200);
		expect(updated.body).toMatchObject({
			projectId: project.body.id,
			authorId: ownerId,
			status: 'DRAFT',
		});
	});

	it('returns 400 for empty updates after successful access checks', async () => {
		await request(app.getHttpServer())
			.patch('/workspaces/' + workspaceId)
			.set(auth(ownerToken))
			.send({})
			.expect(400);
		await request(app.getHttpServer())
			.patch('/projects/' + projectId)
			.set(auth(ownerToken))
			.send({})
			.expect(400);
		await request(app.getHttpServer())
			.patch('/documents/' + documentId)
			.set(auth(ownerToken))
			.send({})
			.expect(400);
	});

	it('archives children idempotently, keeps them visible and does not cascade status', async () => {
		const project = await request(app.getHttpServer())
			.post('/workspaces/' + workspaceId + '/projects')
			.set(auth(ownerToken))
			.send({ name: 'Archive Project' })
			.expect(201);
		const document = await request(app.getHttpServer())
			.post('/projects/' + project.body.id + '/documents')
			.set(auth(ownerToken))
			.send({ title: 'Archive Document', content: '' })
			.expect(201);

		await request(app.getHttpServer())
			.patch('/projects/' + project.body.id + '/archive')
			.set(auth(ownerToken))
			.expect(200)
			.expect((response) => expect(response.body.status).toBe('ARCHIVED'));
		await request(app.getHttpServer())
			.patch('/projects/' + project.body.id + '/archive')
			.set(auth(ownerToken))
			.expect(200)
			.expect((response) => expect(response.body.status).toBe('ARCHIVED'));

		const unchangedDocument = await prisma.document.findUniqueOrThrow({
			where: { id: document.body.id },
		});
		expect(unchangedDocument.status).toBe('DRAFT');

		await request(app.getHttpServer())
			.patch('/documents/' + document.body.id + '/archive')
			.set(auth(ownerToken))
			.expect(200)
			.expect((response) => expect(response.body.status).toBe('ARCHIVED'));
		await request(app.getHttpServer())
			.patch('/documents/' + document.body.id + '/archive')
			.set(auth(ownerToken))
			.expect(200)
			.expect((response) => expect(response.body.status).toBe('ARCHIVED'));

		await request(app.getHttpServer())
			.get('/projects/' + project.body.id)
			.set(auth(ownerToken))
			.expect(200);
		await request(app.getHttpServer())
			.get('/documents/' + document.body.id)
			.set(auth(ownerToken))
			.expect(200);
	});

	it('preserves frontend request and response shapes', async () => {
		const list = await request(app.getHttpServer())
			.get('/projects')
			.set(auth(ownerToken))
			.expect(200);
		const listedProject = list.body.find((project: { id: string }) => project.id === projectId);
		expect(listedProject).toHaveProperty('_count.documents');

		const detail = await request(app.getHttpServer())
			.get('/projects/' + projectId)
			.set(auth(ownerToken))
			.expect(200);
		expect(Array.isArray(detail.body.documents)).toBe(true);
		expect(detail.body.documents[0]).toHaveProperty('author.name');

		const created = await request(app.getHttpServer())
			.post('/projects/' + projectId + '/documents')
			.set(auth(ownerToken))
			.send({
				title: 'Frontend Document',
				content: 'Frontend body',
				status: 'DRAFT',
			})
			.expect(201);
		expect(created.body.status).toBe('DRAFT');

		const fetched = await request(app.getHttpServer())
			.get('/documents/' + created.body.id)
			.set(auth(ownerToken))
			.expect(200);
		expect(fetched.body).toMatchObject({
			projectId,
			title: 'Frontend Document',
			content: 'Frontend body',
		});

		await request(app.getHttpServer())
			.patch('/documents/' + created.body.id)
			.set(auth(ownerToken))
			.send({ title: 'Frontend Document Updated', content: 'Saved' })
			.expect(200);
	});

	it('allows only OWNER to delete project and document resources', async () => {
		const project = await request(app.getHttpServer())
			.post('/workspaces/' + workspaceId + '/projects')
			.set(auth(ownerToken))
			.send({ name: 'Delete Project' })
			.expect(201);
		const document = await request(app.getHttpServer())
			.post('/projects/' + project.body.id + '/documents')
			.set(auth(ownerToken))
			.send({ title: 'Delete Document', content: '' })
			.expect(201);

		await request(app.getHttpServer())
			.delete('/documents/' + document.body.id)
			.set(auth(ownerToken))
			.expect(200);
		await request(app.getHttpServer())
			.delete('/projects/' + project.body.id)
			.set(auth(ownerToken))
			.expect(200);
	});
});
