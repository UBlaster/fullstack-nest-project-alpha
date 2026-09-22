import 'reflect-metadata';
import { setTimeout as delay } from 'node:timers/promises';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { WorkerRuntimeService } from './worker-runtime.service';

async function bootstrap() {
	const app = await NestFactory.createApplicationContext(WorkerModule);
	const runtime = app.get(WorkerRuntimeService);
	runtime.start();

	let stopping = false;
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		try {
			await Promise.race([
				runtime.close(),
				delay(30_000, undefined, { ref: false }).then(() => {
					throw new Error('Worker shutdown timed out');
				}),
			]);
			await app.close();
		} catch (error) {
			await runtime.forceClose();
			await app.close();
			throw error;
		}
	};
	const stop = () => {
		void shutdown().catch((error: unknown) => {
			const name = error instanceof Error ? error.name : 'UnknownError';
			console.error(`Worker shutdown failed: ${name}`);
			process.exitCode = 1;
		});
	};
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
}

void bootstrap();
