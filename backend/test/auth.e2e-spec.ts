import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaClient, WorkspaceRole } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { createAppValidationPipe } from '../src/validation.pipe';

const fixtureEmail = 'task1-fixture@example.com';
const registerEmail = 'task1-register@example.com';
const deletableEmail = 'task1-deletable@example.com';
const password = 'password123';
// bcrypt hash of password123 at cost 4; bcrypt is installed by the task implementation.
const fixturePasswordHash = '$2b$04$heClkgqHsg/Rkkc9SIP6euCj.mEQFsX0boZvQDHEUwvWDLJF2GGEu';
const workspaceId = 'task1-e2e-workspace';
const inaccessibleWorkspaceId = 'task1-e2e-inaccessible-workspace';

describe('Task 1 auth and projects (e2e)', () => {
	let app: INestApplication;
	let prisma: PrismaClient;
	let token: string;
	let deletableToken: string;
	let fixtureUserId: string;

	beforeAll(async () => {
		const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
		app = moduleFixture.createNestApplication();
		app.useGlobalPipes(createAppValidationPipe());
		await app.init();
		prisma = new PrismaClient();
		await prisma.$connect();

		await prisma.workspace.deleteMany({
			where: { id: { in: [workspaceId, inaccessibleWorkspaceId] } },
		});
		await prisma.user.deleteMany({
			where: { email: { in: [fixtureEmail, registerEmail, deletableEmail] } },
		});

		const user = await prisma.user.create({
			data: {
				email: fixtureEmail,
				name: 'Task 1 Fixture',
				password: fixturePasswordHash,
			},
		});
		fixtureUserId = user.id;
		const deletable = await prisma.user.create({
			data: { email: deletableEmail, name: 'Task 1 Deletable', password: fixturePasswordHash },
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

		const jwt = new JwtService({ secret: process.env.JWT_SECRET || 'dev-secret' });
		token = jwt.sign({ sub: user.id, email: user.email });
		deletableToken = jwt.sign({ sub: deletable.id, email: deletable.email });
	});

	afterAll(async () => {
		await prisma.workspace.deleteMany({
			where: { id: { in: [workspaceId, inaccessibleWorkspaceId] } },
		});
		await prisma.user.deleteMany({
			where: { email: { in: [fixtureEmail, registerEmail, deletableEmail] } },
		});
		await prisma.$disconnect();
		await app.close();
	});

	it('logs in with a bcrypt password and normalized email', async () => {
		const response = await request(app.getHttpServer())
			.post('/auth/login')
			.send({ email: fixtureEmail.toUpperCase(), password })
			.expect(200);

		expect(response.body.accessToken).toEqual(expect.any(String));
		expect(response.body.user).toMatchObject({ email: fixtureEmail });
	});

	it('logs in with bcrypt-hashed demo credentials after seed', async () => {
		const demo = await prisma.user.findUnique({ where: { email: 'admin@example.com' } });
		expect(demo?.password).toMatch(/^\$2[aby]\$/);
		await request(app.getHttpServer())
			.post('/auth/login')
			.send({ email: 'admin@example.com', password })
			.expect(200);
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
		expect(storedUser.password).not.toBe(password);
		await request(app.getHttpServer())
			.post('/auth/login')
			.send({ email: registerEmail, password })
			.expect(200);
	});

	it('returns the current user and rejects requests without a token', async () => {
		await request(app.getHttpServer()).get('/auth/me').expect(401);
		await request(app.getHttpServer()).get('/projects').expect(401);
		await request(app.getHttpServer())
			.get('/auth/me')
			.set('Authorization', 'Bearer not-a-jwt')
			.expect(401);
		const response = await request(app.getHttpServer())
			.get('/auth/me')
			.set('Authorization', `Bearer ${token}`)
			.expect(200);

		expect(response.body).toMatchObject({ email: fixtureEmail });
		expect(response.body).not.toHaveProperty('password');
	});

	it('creates and updates projects only through an accessible workspace', async () => {
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

		expect(response.body).toMatchObject({
			workspaceId,
			name: 'Task 1 Project',
			status: 'ACTIVE',
		});
		await request(app.getHttpServer())
			.patch(`/projects/${response.body.id}`)
			.set('Authorization', `Bearer ${token}`)
			.send({})
			.expect(400);

		const updated = await request(app.getHttpServer())
			.patch(`/projects/${response.body.id}`)
			.set('Authorization', `Bearer ${token}`)
			.send({
				name: 'Updated Task 1 Project',
				workspaceId: inaccessibleWorkspaceId,
				status: 'ARCHIVED',
			})
			.expect(200);

		expect(updated.body).toMatchObject({
			workspaceId,
			name: 'Updated Task 1 Project',
			status: 'ACTIVE',
		});
	});

	it('blocks account deletion when resources are owned', async () => {
		await prisma.project.create({
			data: { name: 'Task 1 Owned Project', workspaceId, createdById: fixtureUserId },
		});
		await request(app.getHttpServer())
			.delete('/auth/me')
			.set('Authorization', `Bearer ${token}`)
			.send({ currentPassword: password })
			.expect(409);
	});

	it('deletes an account with no owned resources after password verification', async () => {
		await request(app.getHttpServer())
			.delete('/auth/me')
			.set('Authorization', `Bearer ${deletableToken}`)
			.send({ currentPassword: 'wrong-password' })
			.expect(401);

		await request(app.getHttpServer())
			.delete('/auth/me')
			.set('Authorization', `Bearer ${deletableToken}`)
			.send({ currentPassword: password })
			.expect(200);

		await expect(prisma.user.findUnique({ where: { email: deletableEmail } })).resolves.toBeNull();
	});
});
