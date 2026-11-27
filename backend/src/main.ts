import { shutdownTelemetry } from './instrumentation';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { createAppValidationPipe } from './validation.pipe';
import { appLogger, configureObservability } from './observability/http';

async function bootstrap() {
	const app = await NestFactory.create(AppModule, { rawBody: true, logger: appLogger });
	configureObservability(app);

	app.enableCors({
		origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
		exposedHeaders: ['X-Request-ID'],
	});
	app.useGlobalPipes(createAppValidationPipe());

	const swaggerDocument = SwaggerModule.createDocument(
		app,
		new DocumentBuilder().setTitle('Workspace Docs API').addBearerAuth().build(),
	);
	SwaggerModule.setup('api/docs', app, swaggerDocument);

	await app.listen(process.env.PORT || 3000, '0.0.0.0');
	let stopping = false;
	const close = () => {
		if (stopping) return;
		stopping = true;
		void app
			.close()
			.finally(shutdownTelemetry)
			.catch(() => {
				appLogger.error('API shutdown failed', 'Lifecycle');
				process.exitCode = 1;
			});
	};
	process.once('SIGTERM', close);
	process.once('SIGINT', close);
	new Logger('Release').log(
		JSON.stringify({
			event: 'release_started',
			release: 'D',
			instance: process.env.TASK7_INSTANCE_ID ?? String(process.pid),
			role: 'api',
		}),
	);
}
void bootstrap().catch(() => {
	appLogger.error('API bootstrap failed', 'Lifecycle');
	process.exitCode = 1;
});
