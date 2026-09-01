import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WorkspaceRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createAppValidationPipe } from '../src/validation.pipe';

const fixtureEmail = 'task1-fixture@example.com';
const registerEmail = 'task1-register@example.com';
const password = 'password123';
const workspaceId = 'task1-e2e-workspace';
const inaccessibleWorkspaceId = 'task1-e2e-inaccessible-workspace';

describe('Task 1 auth and projects (e2e)', () => {
	let app: INestApplication;
	let prisma: PrismaService;
	let token: string;
	let createdProjectId: string;

	beforeAll(async () => {
		const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
		app = moduleFixture.createNestApplication();
		app.useGlobalPipes(createAppValidationPipe());
		await app.init();
		prisma = app.get(PrismaService);

		await prisma.workspace.deleteMany({
			where: { id: { in: [workspaceId, inaccessibleWorkspaceId] } },
		});
		await prisma.user.deleteMany({ where: { email: { in: [fixtureEmail, registerEmail] } } });

		const user = await prisma.user.create({
			data: {
				email: fixtureEmail,
				name: 'Task 1 Fixture',
				password: await bcrypt.hash(password, 4),
			},
		});
		await prisma.workspace.create({
			data: {
				id: workspaceId,
				name: 'Task 1 Workspace',
				members: { create: { userId: user.id, role: WorkspaceRole.OWNER } },
			},
		});
		await prisma.workspace.create({
			data: { id: inaccessibleWorkspaceId, name: 'Inaccessible Workspace' },
		});

		const loginResponse = await request(app.getHttpServer())
			.post('/auth/login')
			.send({ email: fixtureEmail.toUpperCase(), password })
			.expect(200);
		token = loginResponse.body.accessToken;
	});

	afterAll(async () => {
		await prisma.workspace.deleteMany({
			where: { id: { in: [workspaceId, inaccessibleWorkspaceId] } },
		});
		await prisma.user.deleteMany({ where: { email: { in: [fixtureEmail, registerEmail] } } });
		await app.close();
	});

	it('uses one 401 response for a wrong password and an unknown email', async () => {
		const wrongPassword = await request(app.getHttpServer())
			.post('/auth/login')
			.send({ email: fixtureEmail, password: 'wrong-password' })
			.expect(401);
		const unknownEmail = await request(app.getHttpServer())
			.post('/auth/login')
			.send({ email: 'missing@example.com', password })
			.expect(401);

		expect(wrongPassword.body.message).toBe('Invalid credentials');
		expect(unknownEmail.body.message).toBe('Invalid credentials');
	});

	it('validates registration, stores a bcrypt hash, and never returns it', async () => {
		await request(app.getHttpServer())
			.post('/auth/register')
			.send({
				email: registerEmail,
				name: 'Task 1 Register',
				password,
				passwordConfirmation: 'different-password',
			})
			.expect(400);

		const response = await request(app.getHttpServer())
			.post('/auth/register')
			.send({
				email: registerEmail.toUpperCase(),
				name: 'Task 1 Register',
				password,
				passwordConfirmation: password,
				role: 'OWNER',
			})
			.expect(201);

		expect(response.body).toMatchObject({ email: registerEmail, name: 'Task 1 Register' });
		expect(response.body).not.toHaveProperty('password');
		expect(response.body).not.toHaveProperty('passwordConfirmation');

		const storedUser = await prisma.user.findUniqueOrThrow({ where: { email: registerEmail } });
		expect(storedUser.password).toMatch(/^\$2[aby]\$/);
		expect(await bcrypt.compare(password, storedUser.password)).toBe(true);
	});

	it('returns the current user and rejects requests without a token', async () => {
		await request(app.getHttpServer()).get('/auth/me').expect(401);
		const response = await request(app.getHttpServer())
			.get('/auth/me')
			.set('Authorization', `Bearer ${token}`)
			.expect(200);

		expect(response.body).toMatchObject({ email: fixtureEmail });
		expect(response.body).not.toHaveProperty('password');
	});

	it('creates projects only through an explicit accessible workspace', async () => {
		await request(app.getHttpServer())
			.post('/projects')
			.set('Authorization', `Bearer ${token}`)
			.send({ name: 'Legacy route' })
			.expect(404);

		await request(app.getHttpServer())
			.post(`/workspaces/${inaccessibleWorkspaceId}/projects`)
			.set('Authorization', `Bearer ${token}`)
			.send({ name: 'Forbidden workspace' })
			.expect(404);

		const response = await request(app.getHttpServer())
			.post(`/workspaces/${workspaceId}/projects`)
			.set('Authorization', `Bearer ${token}`)
			.send({
				name: 'Task 1 Project',
				description: 'Created through an explicit workspace',
				workspaceId: inaccessibleWorkspaceId,
				createdById: 'client-controlled',
				status: 'ARCHIVED',
			})
			.expect(201);

		createdProjectId = response.body.id;
		expect(response.body).toMatchObject({
			workspaceId,
			name: 'Task 1 Project',
			status: 'ACTIVE',
		});
	});

	it('validates project updates and ignores service-managed fields', async () => {
		await request(app.getHttpServer())
			.patch(`/projects/${createdProjectId}`)
			.set('Authorization', `Bearer ${token}`)
			.send({})
			.expect(400);

		const response = await request(app.getHttpServer())
			.patch(`/projects/${createdProjectId}`)
			.set('Authorization', `Bearer ${token}`)
			.send({
				name: 'Updated Task 1 Project',
				workspaceId: inaccessibleWorkspaceId,
				status: 'ARCHIVED',
			})
			.expect(200);

		expect(response.body).toMatchObject({
			workspaceId,
			name: 'Updated Task 1 Project',
			status: 'ACTIVE',
		});
	});

	it('blocks account deletion when resources are owned', async () => {
		await request(app.getHttpServer())
			.delete('/auth/me')
			.set('Authorization', `Bearer ${token}`)
			.send({ currentPassword: password })
			.expect(409);
	});

	it('deletes an account with no owned resources after password verification', async () => {
		const loginResponse = await request(app.getHttpServer())
			.post('/auth/login')
			.send({ email: registerEmail, password })
			.expect(200);
		const registerToken = loginResponse.body.accessToken;

		await request(app.getHttpServer())
			.delete('/auth/me')
			.set('Authorization', `Bearer ${registerToken}`)
			.send({ currentPassword: 'wrong-password' })
			.expect(401);

		await request(app.getHttpServer())
			.delete('/auth/me')
			.set('Authorization', `Bearer ${registerToken}`)
			.send({ currentPassword: password })
			.expect(200);

		await expect(prisma.user.findUnique({ where: { email: registerEmail } })).resolves.toBeNull();
	});
});
