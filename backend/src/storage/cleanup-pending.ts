import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DocumentFilesService } from '../document-files/document-files.service';

async function run() {
	const application = await NestFactory.createApplicationContext(AppModule, {
		logger: ['error', 'warn'],
	});
	try {
		const hours = Number(process.env.DOCUMENT_FILE_PENDING_TTL_HOURS ?? 24);
		if (!Number.isInteger(hours) || hours < 1) {
			throw new Error('DOCUMENT_FILE_PENDING_TTL_HOURS must be a positive integer');
		}
		const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
		const result = await application.get(DocumentFilesService).cleanupStalePending(cutoff);
		process.stdout.write(`Removed stale pending files: ${result.removed}\n`);
	} finally {
		await application.close();
	}
}

void run().catch((error: unknown) => {
	const name = error instanceof Error ? error.name : 'UnknownError';
	process.stderr.write(`Pending cleanup failed: ${name}\n`);
	process.exitCode = 1;
});
