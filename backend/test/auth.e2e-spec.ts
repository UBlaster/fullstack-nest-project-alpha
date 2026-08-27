import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createAppValidationPipe } from '../src/validation.pipe';

const credentials = {
	email: 'admin@example.com',
	password: 'password123',
};

describe('Auth (e2e)', () => {
	let app: INestApplication;
	let token: string;

	beforeAll(async () => {
		const moduleFixture = await Test.createTestingModule({
			imports: [AppModule],
		}).compile();

		app = moduleFixture.createNestApplication();
		app.useGlobalPipes(createAppValidationPipe());
		await app.init();
	});

	afterAll(async () => {
		await app.get(PrismaService).$disconnect();
		await app.close();
	});

	it('logs in with valid seed credentials', async () => {
		const res = await request(app.getHttpServer())
			.post('/auth/login')
			.send(credentials)
			.expect(200);

		expect(res.body.accessToken).toEqual(expect.any(String));
		expect(res.body.user).toMatchObject({
			email: credentials.email,
		});
		token = res.body.accessToken;
	});

	it('ignores extra body fields and still logs in', async () => {
		const res = await request(app.getHttpServer())
			.post('/auth/login')
			.send({
				...credentials,
				extra: 'ignored',
			})
			.expect(200);

		expect(res.body.accessToken).toEqual(expect.any(String));
	});

	it('rejects a wrong password', async () => {
		const res = await request(app.getHttpServer())
			.post('/auth/login')
			.send({
				email: credentials.email,
				password: 'wrong-password',
			})
			.expect(401);

		expect(res.body.message).toBe('Invalid credentials');
	});

	it('rejects an unknown email', async () => {
		const res = await request(app.getHttpServer())
			.post('/auth/login')
			.send({
				email: 'missing@example.com',
				password: credentials.password,
			})
			.expect(401);

		expect(res.body.message).toBe('Invalid credentials');
	});

	it('returns 400 when body is missing', async () => {
		await request(app.getHttpServer()).post('/auth/login').expect(400);
	});

	it('returns 400 for an invalid email', async () => {
		await request(app.getHttpServer())
			.post('/auth/login')
			.send({
				email: 'not-an-email',
				password: credentials.password,
			})
			.expect(400);
	});

	it('returns 400 for an empty password', async () => {
		await request(app.getHttpServer())
			.post('/auth/login')
			.send({
				email: credentials.email,
				password: '',
			})
			.expect(400);
	});

	it('returns the current user for GET /auth/me with a token', async () => {
		const res = await request(app.getHttpServer())
			.get('/auth/me')
			.set('Authorization', `Bearer ${token}`)
			.expect(200);

		expect(res.body).toMatchObject({
			email: credentials.email,
		});
	});

	it('rejects GET /auth/me without a token', async () => {
		await request(app.getHttpServer()).get('/auth/me').expect(401);
	});

	it('rejects GET /auth/me with a garbage JWT', async () => {
		await request(app.getHttpServer())
			.get('/auth/me')
			.set('Authorization', 'Bearer not-a-jwt')
			.expect(401);
	});

	it('rejects GET /projects without a token', async () => {
		await request(app.getHttpServer()).get('/projects').expect(401);
	});

	it('returns projects for GET /projects with a token', async () => {
		const res = await request(app.getHttpServer())
			.get('/projects')
			.set('Authorization', `Bearer ${token}`)
			.expect(200);

		expect(Array.isArray(res.body)).toBe(true);
	});
});
