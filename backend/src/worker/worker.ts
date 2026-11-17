import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { WorkerRuntimeService } from './worker-runtime.service';
import { shutdownWorker } from './worker-shutdown';
import { PaymentMaintenanceService } from '../payments/payment-maintenance.service';

async function bootstrap() {
	const app = await NestFactory.createApplicationContext(WorkerModule);
	const runtime = app.get(WorkerRuntimeService);
	const payments = app.get(PaymentMaintenanceService);
	runtime.start();
	payments.start();
	new Logger('Release').log(
		JSON.stringify({
			event: 'release_started',
			release: 'D',
			instance: process.env.TASK7_INSTANCE_ID ?? String(process.pid),
			role: 'worker',
		}),
	);

	let stopping = false;
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		await shutdownWorker(
			{
				close: async () => {
					const results = await Promise.allSettled([payments.stop(), runtime.close()]);
					if (results.some((result) => result.status === 'rejected')) {
						throw new Error('Worker runtime shutdown failed');
					}
				},
			},
			app,
		);
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
