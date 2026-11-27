import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { rolloutHttpFailure } from './embeddings.errors';
import { EmbeddingsModule } from './embeddings.module';
import { EmbeddingSettings } from './embedding-settings';
import { EmbeddingsService } from './embeddings.service';

async function main() {
	const [action, version] = process.argv.slice(2);
	if (!action || !version) throw new Error('Supply rollout action and version');
	if (action === 'probe') {
		const settings = new EmbeddingSettings();
		console.log(JSON.stringify(await settings.probe(version)));
		return;
	}
	const app = await NestFactory.createApplicationContext(EmbeddingsModule, { logger: false });
	try {
		const result = await app.get(EmbeddingsService).rollout(action, version);
		console.log(JSON.stringify(result));
	} finally {
		await app.close();
	}
}

void main().catch((error: unknown) => {
	const failure = rolloutHttpFailure(error);
	if (failure) console.log(JSON.stringify(failure));
	else
		console.error(
			'Embedding rollout failed. Check version configuration, write policy and coverage.',
		);
	process.exitCode = 1;
});
