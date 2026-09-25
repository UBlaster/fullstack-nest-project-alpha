import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { WorkerRuntimeService } from './worker-runtime.service';
import { shutdownWorker } from './worker-shutdown';

async function bootstrap() {
	const app = await NestFactory.createApplicationContext(WorkerModule);
	const runtime = app.get(WorkerRuntimeService);
	runtime.start();

	let stopping = false;
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		await shutdownWorker(runtime, app);
	};
	const stop = () => {
		void shutdown().catch((error: unknown) => {
			const name = error instanceof Error ? error.name : 'UnknownError';
			console.error(`Worker shutdown failed: ${name}`);
			process.exit(1);
		});
	};
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
}

void bootstrap();
