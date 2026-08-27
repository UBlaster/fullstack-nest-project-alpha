import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { createAppValidationPipe } from './validation.pipe';

async function bootstrap() {
	const app = await NestFactory.create(AppModule);

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
}
bootstrap();
