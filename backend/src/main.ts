import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { createAppValidationPipe } from './validation.pipe';
import { requestContextMiddleware } from './diagnostics/request-context';

async function bootstrap() {
	const app = await NestFactory.create(AppModule);
	app.use(requestContextMiddleware);

	app.enableCors({
		origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
	});
	app.useGlobalPipes(createAppValidationPipe());

	const swaggerDocument = SwaggerModule.createDocument(
		app,
		new DocumentBuilder().setTitle('Workspace Docs API').addBearerAuth().build(),
	);
	SwaggerModule.setup('api/docs', app, swaggerDocument);

	await app.listen(process.env.PORT || 3000, '0.0.0.0');
	new Logger('Release').log(
		JSON.stringify({
			event: 'release_started',
			release: 'D',
			instance: process.env.TASK7_INSTANCE_ID ?? String(process.pid),
			role: 'api',
		}),
	);
}
bootstrap();
