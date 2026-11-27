import { Injectable } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	EmbeddingBatch,
	EmbeddingProvider,
	embeddingDimension,
	FakeEmbeddingProvider,
	VoyageEmbeddingProvider,
	vectorLiteral,
} from './embedding-provider';
import { EmbeddingTemporaryError } from './embeddings.errors';
import { meter, withSpan } from '../observability/telemetry';

const inputs = meter.createCounter('embedding.inputs');
const tokens = meter.createCounter('embedding.tokens');

function integer(name: string, fallback: number, max: number): number {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('Invalid ' + name);
	return value;
}

export type EmbeddingProfile = {
	version: string;
	model: string;
	provider: EmbeddingProvider;
	providerName: 'fake' | 'voyage';
};

export function assertValidEmbeddingVersion(version: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(version))
		throw new Error('Invalid embedding version');
}

@Injectable()
export class EmbeddingSettings {
	readonly primary = process.env.EMBEDDING_VERSION ?? 'v1';
	readonly batchSize = integer('EMBEDDING_BATCH_SIZE', 16, 64);
	readonly concurrency = integer('EMBEDDING_CONCURRENCY', 2, 8);
	readonly byteBudget = integer('EMBEDDING_BATCH_BYTES', 24000, 96000);
	private readonly rpm = integer('EMBEDDING_REQUESTS_PER_MINUTE', 120, 60000);
	private readonly profiles = new Map<string, EmbeddingProfile>();
	private readonly waiting: (() => void)[] = [];
	private active = 0;
	private nextStart = 0;

	constructor() {
		if (Number(process.env.EMBEDDING_DIMENSION ?? embeddingDimension) !== embeddingDimension) {
			throw new Error('EMBEDDING_DIMENSION must match the vector(1024) migration');
		}
		const primaryProvider = process.env.EMBEDDING_PROVIDER ?? 'fake';
		this.register(this.primary, primaryProvider, process.env.VOYAGE_EMBEDDING_MODEL);
		const next = process.env.EMBEDDING_NEXT_VERSION;
		if (next) {
			this.register(
				next,
				process.env.EMBEDDING_NEXT_PROVIDER || primaryProvider,
				process.env.VOYAGE_NEXT_EMBEDDING_MODEL,
			);
		}
	}

	private register(version: string, providerName: string, voyageModel: string | undefined) {
		assertValidEmbeddingVersion(version);
		if (this.profiles.has(version)) {
			throw new Error('Invalid or duplicate embedding version');
		}
		if (providerName === 'fake') {
			const model = 'fake-' + version;
			this.profiles.set(version, {
				version,
				model,
				providerName,
				provider: new FakeEmbeddingProvider(model),
			});
			return;
		}
		if (providerName !== 'voyage' || !voyageModel?.trim() || !process.env.VOYAGE_API_KEY?.trim()) {
			throw new Error('Voyage requires explicit provider, model and key');
		}
		const provider = new VoyageEmbeddingProvider(voyageModel, process.env.VOYAGE_API_KEY);
		this.profiles.set(version, { version, model: voyageModel, providerName, provider });
	}

	profile(version: string): EmbeddingProfile {
		const profile = this.profiles.get(version);
		if (!profile) throw new Error('Unknown embedding version');
		return profile;
	}

	async probe(version: string) {
		const profile = this.profile(version);
		const fixtures = [
			['document', 'The public library opens at nine in the morning.'],
			['query', 'When does the public library open?'],
		] as const;
		for (const [kind, input] of fixtures) {
			const batch = await this.request(profile, [input], kind);
			const vector = batch.vectors[0];
			if (batch.vectors.length !== 1 || !vector) throw new Error('Incomplete embedding probe');
			vectorLiteral(vector);
		}
		return {
			version,
			provider: profile.providerName,
			model: profile.model,
			dimension: embeddingDimension,
			documentCount: 1,
			queryCount: 1,
		};
	}

	async request(
		profile: EmbeddingProfile,
		values: string[],
		kind: 'document' | 'query',
		signal?: AbortSignal,
		beforeSend?: () => Promise<void>,
	): Promise<EmbeddingBatch> {
		if (this.active >= this.concurrency) {
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		} else {
			this.active++;
		}
		const send = async () => {
			signal?.throwIfAborted();
			const start = Math.max(Date.now(), this.nextStart);
			this.nextStart = start + Math.ceil(60000 / this.rpm);
			if (start > Date.now()) await sleep(start - Date.now(), undefined, { signal });
			await beforeSend?.();
			signal?.throwIfAborted();
			const labels = { provider: profile.providerName, input_type: kind };
			return await withSpan('embedding.' + kind, async () => {
				inputs.add(values.length, labels);
				const batch = await (kind === 'query'
					? profile.provider.embedQuery(values[0])
					: profile.provider.embedDocuments(values, signal));
				tokens.add(batch.tokens, labels);
				return batch;
			});
		};
		try {
			try {
				return await send();
			} catch (error) {
				// Only a confirmed provider rejection is safe for an in-stage HTTP retry.
				// A lost response may already have produced a billable embedding.
				if (
					kind !== 'document' ||
					profile.providerName !== 'voyage' ||
					!signal ||
					!beforeSend ||
					!(error instanceof EmbeddingTemporaryError) ||
					error.httpStatus !== 429
				)
					throw error;
				const wait = Math.max(61_000, (error.retryAt ?? 0) - Date.now());
				await sleep(Math.min(wait, 120_000), undefined, { signal });
				if (wait > 120_000) throw error;
			}
			return await send();
		} finally {
			const next = this.waiting.shift();
			if (next) next();
			else this.active--;
		}
	}
}
