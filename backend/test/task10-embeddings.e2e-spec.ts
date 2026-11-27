import * as timers from 'node:timers/promises';
import { EmbeddingTemporaryError, rolloutHttpFailure } from '../src/embeddings/embeddings.errors';
import { EmbeddingSettings } from '../src/embeddings/embedding-settings';
import { EmbeddingsService } from '../src/embeddings/embeddings.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
	FakeEmbeddingProvider,
	VoyageEmbeddingProvider,
	embeddingDimension,
	vectorLiteral,
} from '../src/embeddings/embedding-provider';
import { rankDocuments, SearchCandidate } from '../src/search/search.service';

const axis = (index: number) =>
	Array.from({ length: embeddingDimension }, (_, i) => Number(i === index));
const success = (data: unknown) => Response.json({ data, usage: { total_tokens: 8 } });

describe('Task 10 embedding adapters and RRF', () => {
	it('keeps fixture synonyms deterministic within each model and spaces distinct', async () => {
		const fake = new FakeEmbeddingProvider('fake-v1');
		const next = new FakeEmbeddingProvider('fake-v2');
		const first = (await fake.embedDocuments(['snapshot'])).vectors[0];
		expect((await fake.embedQuery('backup')).vectors[0]).toEqual(first);
		expect((await next.embedQuery('backup')).vectors[0]).not.toEqual(first);
		expect((await fake.embedQuery('puppy')).vectors[0]).not.toEqual(first);
	});

	it('uses distinct Voyage input types and aligns reordered vectors to caller order', async () => {
		const request = jest
			.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
			.mockResolvedValueOnce(
				success([
					{ index: 1, embedding: axis(1) },
					{ index: 0, embedding: axis(0) },
				]),
			)
			.mockResolvedValueOnce(success([{ index: 0, embedding: axis(2) }]));
		const provider = new VoyageEmbeddingProvider('model', 'test', request);
		expect((await provider.embedDocuments(['one', 'two'])).vectors).toEqual([axis(0), axis(1)]);
		await provider.embedQuery('three');
		expect(request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).input_type)).toEqual(
			['document', 'query'],
		);
		expect(JSON.parse(String(request.mock.calls[0][1]?.body)).output_dimension).toBe(
			embeddingDimension,
		);
	});

	it('preserves stable indexes for a partial provider batch', async () => {
		const provider = new VoyageEmbeddingProvider('model', 'test', async () =>
			success([{ index: 1, embedding: axis(1) }]),
		);
		const { vectors } = await provider.embedDocuments(['one', 'two']);
		expect(vectors[0]).toBeUndefined();
		expect(vectors[1]).toEqual(axis(1));
	});

	it.each([401, 403, 429, 503])(
		'exposes only the HTTP status from a rejected Voyage response (%i)',
		async (status) => {
			const provider = new VoyageEmbeddingProvider(
				'model',
				'fixture-key',
				async () => new Response('private provider diagnostic', { status }),
			);
			const failure = await provider.embedQuery('private query').catch(rolloutHttpFailure);
			expect(failure).toEqual({ error: 'EMBEDDING_ROLLOUT_FAILED', httpStatus: status });
		},
	);

	it('omits an HTTP status for transport errors, unexpected exceptions, and invalid values', async () => {
		const provider = new VoyageEmbeddingProvider('model', 'fixture-key', async () => {
			throw new Error('private network detail');
		});
		expect(await provider.embedQuery('private query').catch(rolloutHttpFailure)).toBeUndefined();
		expect(rolloutHttpFailure({ httpStatus: 403 })).toBeUndefined();
		for (const invalid of [200, 400.1, 600, NaN]) {
			expect(
				rolloutHttpFailure(new EmbeddingTemporaryError('private detail', invalid)),
			).toBeUndefined();
		}
	});

	it('honors Retry-After across calls and discards provider error bodies', async () => {
		const request = jest
			.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
			.mockResolvedValueOnce(
				new Response('private provider diagnostic', {
					status: 429,
					headers: { 'Retry-After': '90' },
				}),
			);
		const provider = new VoyageEmbeddingProvider('model', 'test', request);
		await expect(provider.embedQuery('a')).rejects.toThrow('PROVIDER_UNAVAILABLE');
		await expect(provider.embedQuery('b')).rejects.toThrow('PROVIDER_COOLDOWN');
		expect(request).toHaveBeenCalledTimes(1);
	});

	it.each([1, 2])(
		'a lost stage lease at fence %i cannot write an embedding batch',
		async (lostAt) => {
			const settings = new EmbeddingSettings();
			const profile = settings.profile(settings.primary);
			const send = jest
				.spyOn(profile.provider, 'embedDocuments')
				.mockResolvedValue({ vectors: [axis(0)], tokens: 1 });
			const tx = { $executeRaw: jest.fn() };
			const db = {
				$queryRaw: jest
					.fn()
					.mockResolvedValueOnce([])
					.mockResolvedValueOnce([{ id: 'chunk', text: 'fixture' }]),
				$transaction: async (fn: (tx: object) => Promise<void>) => fn(tx),
			};
			let fences = 0;
			const guard = async () => {
				if (++fences === lostAt) throw new Error('LEASE_LOST');
			};
			const service = new EmbeddingsService(db as unknown as PrismaService, settings);
			await expect(
				service.embedVersion('version', new AbortController().signal, guard),
			).rejects.toThrow('LEASE_LOST');
			expect(send).toHaveBeenCalledTimes(lostAt - 1);
			expect(tx.$executeRaw).not.toHaveBeenCalled();
		},
	);

	it('validates vector dimension, finiteness and nonzero cosine norm', () => {
		expect(() => vectorLiteral([NaN])).toThrow();
		expect(() => vectorLiteral(Array(embeddingDimension).fill(Infinity))).toThrow();
		expect(() => vectorLiteral(Array(embeddingDimension).fill(0))).toThrow();
	});

	it('adds reciprocal ranks by document, reporting both channels and the winning passage', () => {
		const candidate = (id: string, score: number, snippet: string): SearchCandidate => ({
			documentId: id,
			projectId: 'p',
			updatedAt: new Date(0),
			title: id,
			snippet,
			score,
		});
		const hits = rankDocuments(
			[candidate('a', 0.9, 'first'), candidate('b', 0.7, 'title')],
			[candidate('b', 0.6, 'passage')],
			1,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({
			documentId: 'b',
			snippet: 'passage',
			matchedBy: ['lexical', 'semantic'],
			scores: { rrf: 1 / 61 + 1 / 62, lexical: 0.7, semantic: 0.6 },
		});
	});
});

describe('Task 10 embedding profiles', () => {
	function configure(overrides: Record<string, string> = {}) {
		jest.replaceProperty(process, 'env', {
			...process.env,
			EMBEDDING_PROVIDER: 'fake',
			EMBEDDING_VERSION: 'v1',
			EMBEDDING_DIMENSION: '1024',
			EMBEDDING_NEXT_VERSION: 'voyage-4-v1',
			EMBEDDING_NEXT_PROVIDER: 'voyage',
			VOYAGE_EMBEDDING_MODEL: '',
			VOYAGE_NEXT_EMBEDDING_MODEL: 'voyage-4',
			VOYAGE_API_KEY: '',
			EMBEDDING_REQUESTS_PER_MINUTE: '60000',
			...overrides,
		});
	}

	afterEach(() => jest.restoreAllMocks());

	it('probes the fake primary and the Voyage target independently using the selected model and dimension', async () => {
		configure({ VOYAGE_API_KEY: 'fixture-key' });
		const request = jest
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(success([{ index: 0, embedding: axis(1) }]))
			.mockResolvedValueOnce(success([{ index: 0, embedding: axis(2) }]));
		const settings = new EmbeddingSettings();
		expect((await settings.probe('v1')).provider).toBe('fake');
		expect(request).not.toHaveBeenCalled();
		expect(await settings.probe('voyage-4-v1')).toEqual({
			version: 'voyage-4-v1',
			provider: 'voyage',
			model: 'voyage-4',
			dimension: 1024,
			documentCount: 1,
			queryCount: 1,
		});
		expect(request).toHaveBeenCalledTimes(2);
		for (const [index, [, init]] of request.mock.calls.entries()) {
			const body = JSON.parse(String(init?.body));
			expect(body).toMatchObject({
				model: 'voyage-4',
				output_dimension: 1024,
				input_type: index === 0 ? 'document' : 'query',
			});
			expect(body.input).toHaveLength(1);
		}
	});

	it('does not report a successful probe for an incompatible query vector', async () => {
		configure({ VOYAGE_API_KEY: 'fixture-key' });
		jest
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(success([{ index: 0, embedding: axis(1) }]))
			.mockResolvedValueOnce(success([{ index: 0, embedding: [1, 0] }]));
		await expect(new EmbeddingSettings().probe('voyage-4-v1')).rejects.toThrow('INVALID_VECTOR');
	});

	it.each([
		[{ EMBEDDING_NEXT_VERSION: '' }, true],
		[{ EMBEDDING_NEXT_PROVIDER: '' }, true],
		[{ EMBEDDING_NEXT_PROVIDER: 'fake' }, true],
		[{ EMBEDDING_NEXT_PROVIDER: 'voyage' }, false],
		[
			{
				EMBEDDING_PROVIDER: 'voyage',
				VOYAGE_EMBEDDING_MODEL: 'voyage-4',
				EMBEDDING_NEXT_PROVIDER: 'fake',
			},
			false,
		],
	] as [Record<string, string>, boolean][])(
		'requires credentials only for configured Voyage profiles',
		(env, works) => {
			configure(env);
			if (works) expect(() => new EmbeddingSettings()).not.toThrow();
			else expect(() => new EmbeddingSettings()).toThrow('model and key');
		},
	);

	function useVirtualProviderWait() {
		let now = Date.now();
		jest.spyOn(Date, 'now').mockImplementation(() => now);
		return jest.spyOn(timers, 'setTimeout').mockImplementation(async (ms = 0, value, options) => {
			options?.signal?.throwIfAborted();
			now += ms;
			return value;
		});
	}

	it.each([
		[undefined, 61000],
		['80', 80000],
	] as const)(
		'rechecks the stage lease and retries a confirmed 429 after %s',
		async (header, delayMs) => {
			configure({ VOYAGE_API_KEY: 'fixture-key' });
			const wait = useVirtualProviderWait();
			const request = jest
				.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce(
					new Response(null, {
						status: 429,
						headers: header ? { 'retry-after': header } : undefined,
					}),
				)
				.mockResolvedValueOnce(success([{ index: 0, embedding: axis(0) }]));
			const settings = new EmbeddingSettings(),
				guard = jest.fn(async () => {});
			const signal = new AbortController().signal;
			await settings.request(
				settings.profile('voyage-4-v1'),
				['fixture'],
				'document',
				signal,
				guard,
			);
			expect(request).toHaveBeenCalledTimes(2);
			expect(wait).toHaveBeenCalledTimes(1);
			expect(wait).toHaveBeenCalledWith(delayMs, undefined, { signal });
			expect(guard).toHaveBeenCalledTimes(2);
			expect(guard.mock.invocationCallOrder[1]).toBeLessThan(request.mock.invocationCallOrder[1]);
		},
	);

	it.each(['aborted', 'lease revoked', 'second rejection', 'long cooldown'] as const)(
		'bounds or cancels a throttled stage when %s',
		async (outcome) => {
			configure({ VOYAGE_API_KEY: 'fixture-key' });
			const wait = useVirtualProviderWait(),
				abort = new AbortController();
			if (outcome === 'aborted')
				wait.mockImplementationOnce(async () => {
					abort.abort(new Error('lease lost'));
					abort.signal.throwIfAborted();
				});
			const request = jest.spyOn(globalThis, 'fetch').mockImplementation(
				async () =>
					new Response(null, {
						status: 429,
						headers: outcome === 'long cooldown' ? { 'retry-after': '240' } : undefined,
					}),
			);
			const guard = jest.fn(async () => {});
			if (outcome === 'lease revoked')
				guard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('lease lost'));
			const settings = new EmbeddingSettings();
			await expect(
				settings.request(
					settings.profile('voyage-4-v1'),
					['fixture'],
					'document',
					abort.signal,
					guard,
				),
			).rejects.toThrow();
			expect(wait).toHaveBeenCalledTimes(1);
			expect(wait.mock.calls[0][0]).toBe(outcome === 'long cooldown' ? 120000 : 61000);
			expect(request).toHaveBeenCalledTimes(outcome === 'second rejection' ? 2 : 1);
		},
	);

	it.each([
		['query', 429, false],
		['document', 429, false],
		['document', 503, true],
	] as const)('leaves %s / %i / stage=%s to its caller', async (kind, status, worker) => {
		configure({ VOYAGE_API_KEY: 'fixture-key' });
		const wait = useVirtualProviderWait();
		const request = jest
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(null, { status }));
		const settings = new EmbeddingSettings();
		await expect(
			settings.request(
				settings.profile('voyage-4-v1'),
				['fixture'],
				kind,
				worker ? new AbortController().signal : undefined,
				worker ? async () => {} : undefined,
			),
		).rejects.toMatchObject({ httpStatus: status });
		expect(wait).not.toHaveBeenCalled();
		expect(request).toHaveBeenCalledTimes(1);
	});
	it('inherits the primary Voyage provider when the target has no override', () => {
		configure({
			EMBEDDING_PROVIDER: 'voyage',
			VOYAGE_EMBEDDING_MODEL: 'voyage-4-lite',
			EMBEDDING_NEXT_PROVIDER: '',
			VOYAGE_API_KEY: 'fixture-key',
		});
		const settings = new EmbeddingSettings();
		expect(settings.profile('v1')).toMatchObject({
			providerName: 'voyage',
			model: 'voyage-4-lite',
		});
		expect(settings.profile('voyage-4-v1')).toMatchObject({
			providerName: 'voyage',
			model: 'voyage-4',
		});
	});

	it('retires only a stored inactive target without its provider credentials', async () => {
		configure({ EMBEDDING_NEXT_VERSION: '' });
		const tx = {
			$executeRaw: jest.fn(),
			$queryRaw: async () => [{ embeddingVersion: 'v1', writeVersions: ['v1', 'voyage-4-v1'] }],
		};
		const db = { $transaction: async (work: (tx: object) => Promise<unknown>) => work(tx) };
		const service = new EmbeddingsService(db as unknown as PrismaService, new EmbeddingSettings());
		await expect(service.rollout('retire', 'v1')).rejects.toThrow('Cannot retire the read version');
		await expect(service.rollout('retire', 'unknown')).rejects.toThrow('Unknown embedding version');
		await expect(service.rollout('retire', 'voyage-4-v1')).resolves.toEqual({
			embeddingVersion: 'v1',
			writeVersions: ['v1'],
		});
	});
});
