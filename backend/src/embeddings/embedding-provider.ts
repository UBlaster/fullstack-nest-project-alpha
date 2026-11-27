import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { EmbeddingTemporaryError, EmbeddingValidationError } from './embeddings.errors';

// The column and its cosine index are created together in the pgvector migration.
export const embeddingDimension = 1024;

export interface EmbeddingBatch {
	vectors: (number[] | undefined)[];
	tokens: number;
}

export interface EmbeddingProvider {
	embedDocuments(texts: string[], signal?: AbortSignal): Promise<EmbeddingBatch>;
	embedQuery(text: string): Promise<EmbeddingBatch>;
}

export function vectorLiteral(vector: number[]): string {
	if (
		vector.length !== embeddingDimension ||
		vector.some((n) => !Number.isFinite(Math.fround(n)) || typeof n !== 'number') ||
		!vector.some((n) => Math.fround(n) !== 0)
	) {
		throw new EmbeddingValidationError('INVALID_VECTOR');
	}
	return '[' + vector.join(',') + ']';
}

// Only this small, explicit fixture vocabulary has synonym behavior.
const synonyms = new Map(
	[
		['car', 'cars', 'automobile', 'vehicle'],
		['dog', 'dogs', 'canine', 'puppy'],
		['backup', 'snapshot', 'snapshots', 'restore', 'restores', 'recovery'],
	].flatMap(([concept, ...words]) => words.map((word) => [word, concept] as const)),
);

export class FakeEmbeddingProvider implements EmbeddingProvider {
	constructor(private readonly model: string) {}

	embedDocuments(texts: string[]): Promise<EmbeddingBatch> {
		let tokens = 0;
		const buckets = new Map<string, number>();
		const vectors = texts.map((text) => {
			const words =
				text
					.normalize('NFKC')
					.toLowerCase()
					.match(/[\p{L}\p{N}]+/gu) ?? [];
			const vector = new Array<number>(embeddingDimension).fill(0);
			for (const word of words.length ? words : ['<empty>']) {
				const concept = synonyms.get(word) ?? word;
				let bucket = buckets.get(concept);
				if (bucket === undefined) {
					const digest = createHash('sha256')
						.update(this.model + '/' + concept)
						.digest();
					bucket = digest.readUInt32BE(0) % embeddingDimension;
					buckets.set(concept, bucket);
				}
				vector[bucket] += 1;
			}
			tokens += words.length;
			return vector;
		});
		return Promise.resolve({ vectors, tokens });
	}

	embedQuery(text: string) {
		return this.embedDocuments([text]);
	}
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
	private availableAt = 0;

	constructor(
		private readonly model: string,
		private readonly key: string,
		private readonly request: typeof fetch = fetch,
	) {
		if (['voyage-3-lite', 'voyage-lite-02-instruct', 'voyage-large-2'].includes(model)) {
			throw new EmbeddingValidationError('MODEL_REQUIRES_DIFFERENT_VECTOR_DIMENSION');
		}
	}

	embedDocuments(texts: string[], signal?: AbortSignal) {
		return this.embed(texts, 'document', signal);
	}

	embedQuery(text: string) {
		return this.embed([text], 'query');
	}

	private async embed(
		input: string[],
		inputType: 'document' | 'query',
		signal?: AbortSignal,
	): Promise<EmbeddingBatch> {
		const wait = this.availableAt - Date.now();
		if (wait > 5000) throw new EmbeddingTemporaryError('PROVIDER_COOLDOWN');
		if (wait > 0) await sleep(wait, undefined, { signal });
		signal?.throwIfAborted();
		let response: Response;
		try {
			response = await this.request('https://api.voyageai.com/v1/embeddings', {
				method: 'POST',
				headers: { Authorization: 'Bearer ' + this.key, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: this.model,
					input,
					input_type: inputType,
					// Fixed-dimension models use their native 1024; all results are validated.
					output_dimension: [
						'voyage-3',
						'voyage-2',
						'voyage-law-2',
						'voyage-finance-2',
						'voyage-multilingual-2',
						'voyage-large-2-instruct',
						'voyage-code-2',
					].includes(this.model)
						? undefined
						: embeddingDimension,
					truncation: false,
				}),
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(20000)])
					: AbortSignal.timeout(20000),
				redirect: 'error',
			});
		} catch {
			throw new EmbeddingTemporaryError('PROVIDER_UNAVAILABLE');
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			if ([408, 429].includes(response.status) || response.status >= 500) {
				const header = response.headers.get('retry-after');
				const seconds = header === null ? NaN : Number(header);
				const until = Number.isFinite(seconds)
					? Date.now() + seconds * 1000
					: Date.parse(header ?? '');
				if (Number.isFinite(until)) this.availableAt = Math.max(this.availableAt, until);
				throw new EmbeddingTemporaryError(
					'PROVIDER_UNAVAILABLE',
					response.status,
					this.availableAt,
				);
			}
			throw new EmbeddingValidationError('PROVIDER_REJECTED', response.status);
		}
		const body = (await response.json().catch(() => null)) as {
			data?: { index: number; embedding: number[] }[];
			usage?: { total_tokens: number };
		} | null;
		if (!Array.isArray(body?.data) || !body.data.length || body.data.length > input.length) {
			throw new EmbeddingTemporaryError('INVALID_PROVIDER_RESPONSE');
		}
		const vectors: (number[] | undefined)[] = new Array(input.length);
		for (const item of body.data) {
			if (
				!item ||
				!Number.isInteger(item.index) ||
				item.index < 0 ||
				item.index >= input.length ||
				vectors[item.index] ||
				!Array.isArray(item.embedding)
			) {
				throw new EmbeddingTemporaryError('INVALID_PROVIDER_RESPONSE');
			}
			vectorLiteral(item.embedding);
			vectors[item.index] = item.embedding;
		}
		const tokens = body.usage?.total_tokens;
		if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) {
			throw new EmbeddingTemporaryError('INVALID_PROVIDER_RESPONSE');
		}
		return { vectors, tokens };
	}
}
