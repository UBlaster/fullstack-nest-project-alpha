import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
	assertValidEmbeddingVersion,
	EmbeddingProfile,
	EmbeddingSettings,
} from './embedding-settings';
import { embeddingDimension, vectorLiteral } from './embedding-provider';
import { EmbeddingTemporaryError, EmbeddingValidationError } from './embeddings.errors';

type Policy = { embeddingVersion: string; writeVersions: string[] };
type Chunk = { id: string; text: string };
type Client = Prisma.TransactionClient;
type LeaseGuard = (tx: Client) => Promise<void>;

@Injectable()
export class EmbeddingsService {
	constructor(
		private readonly db: PrismaService,
		private readonly settings: EmbeddingSettings,
	) {}

	private async policy(db: Client): Promise<Policy> {
		const [row] = await db.$queryRaw<Policy[]>`
			SELECT "embeddingVersion", "writeVersions" FROM "EmbeddingReadConfig" WHERE id = 'default'`;
		return (
			row ?? { embeddingVersion: this.settings.primary, writeVersions: [this.settings.primary] }
		);
	}

	async queryEmbedding(text: string) {
		const { embeddingVersion } = await this.policy(this.db);
		const profile = this.settings.profile(embeddingVersion);
		try {
			const batch = await this.settings.request(profile, [text], 'query');
			if (!batch.vectors[0]) throw new EmbeddingTemporaryError('MISSING_QUERY_VECTOR');
			return { embeddingVersion, model: profile.model, literal: vectorLiteral(batch.vectors[0]) };
		} catch (error) {
			if (error instanceof EmbeddingTemporaryError || error instanceof EmbeddingValidationError) {
				throw new ServiceUnavailableException('Search embedding unavailable');
			}
			throw error;
		}
	}

	async embedVersion(versionId: string, signal?: AbortSignal, guard?: LeaseGuard) {
		const { writeVersions } = await this.policy(this.db);
		for (const version of writeVersions) {
			await this.fill(this.settings.profile(version), versionId, signal, guard);
		}
	}

	private async fill(
		profile: EmbeddingProfile,
		versionId?: string,
		signal?: AbortSignal,
		guard?: LeaseGuard,
	) {
		const scope =
			versionId === undefined
				? Prisma.sql` v.status = 'INDEXED'`
				: Prisma.sql` c."versionId" = ${versionId} `;
		let written = 0;
		let afterId = '';
		for (;;) {
			signal?.throwIfAborted();
			const chunks = await this.db.$queryRaw<Chunk[]>`
				SELECT c.id, c.text FROM "DocumentChunk" c
				JOIN "DocumentVersion" v ON v.id = c."versionId"
				WHERE ${scope} AND c.id > ${afterId} AND NOT EXISTS (
					SELECT 1 FROM "DocumentEmbedding" e WHERE e."chunkId" = c.id
						AND e."embeddingVersion" = ${profile.version} AND e.model = ${profile.model}
						AND e.status = 'READY')
				ORDER BY c.id LIMIT ${this.settings.batchSize * this.settings.concurrency}`;
			if (!chunks.length) return written;
			afterId = chunks[chunks.length - 1].id;
			const batches: Chunk[][] = [];
			let batch: Chunk[] = [];
			let bytes = 0;
			for (const chunk of chunks) {
				const size = Buffer.byteLength(chunk.text, 'utf8') + 16;
				if (size > this.settings.byteBudget) throw new EmbeddingValidationError('INPUT_TOO_LARGE');
				if (
					batch.length &&
					(batch.length === this.settings.batchSize || bytes + size > this.settings.byteBudget)
				) {
					batches.push(batch);
					batch = [];
					bytes = 0;
				}
				batch.push(chunk);
				bytes += size;
			}
			if (batch.length) batches.push(batch);
			for (let i = 0; i < batches.length; i += this.settings.concurrency) {
				signal?.throwIfAborted();
				const results = await Promise.allSettled(
					batches
						.slice(i, i + this.settings.concurrency)
						.map((part) => this.persistBatch(profile, part, signal, guard)),
				);
				for (const result of results) {
					if (result.status === 'rejected') throw result.reason;
					if (result.value === null) return written;
					written += result.value;
				}
			}
		}
	}

	private async persistBatch(
		profile: EmbeddingProfile,
		chunks: Chunk[],
		signal?: AbortSignal,
		guard?: LeaseGuard,
	) {
		const batch = await this.settings.request(
			profile,
			chunks.map((chunk) => chunk.text),
			'document',
			signal,
			guard && (() => this.db.$transaction(guard)),
		);
		signal?.throwIfAborted();
		const rows = chunks.flatMap((chunk, index) => {
			const vector = batch.vectors[index];
			if (!vector) return [];
			return [
				Prisma.sql`(${randomUUID()}, ${chunk.id}, ${profile.version}, ${profile.model},
				${embeddingDimension}, 'READY', ${vectorLiteral(vector)}::vector)`,
			];
		});
		if (!rows.length) throw new EmbeddingTemporaryError('MISSING_PROVIDER_VECTORS');
		const written = await this.db.$transaction(async (tx) => {
			if (guard) await guard(tx);
			await this.lockPolicy(tx);
			if (!(await this.policy(tx)).writeVersions.includes(profile.version)) return null;
			const count = await tx.$executeRaw` INSERT INTO "DocumentEmbedding"
				(id, "chunkId", "embeddingVersion", model, dimension, status, embedding)
				VALUES ${Prisma.join(rows)}
				ON CONFLICT ("chunkId", "embeddingVersion") DO NOTHING`;
			if (count < rows.length) {
				const [mismatch] = await tx.$queryRaw<{ present: boolean }[]>` SELECT EXISTS(
					SELECT 1 FROM "DocumentEmbedding" WHERE "chunkId" IN (${Prisma.join(chunks.map((c) => c.id))})
						AND "embeddingVersion" = ${profile.version} AND (model <> ${profile.model} OR status <> 'READY')
				) AS present`;
				if (mismatch.present) throw new EmbeddingValidationError('EMBEDDING_VERSION_CONFLICT');
			}
			return count;
		});
		if (rows.length !== chunks.length) throw new EmbeddingTemporaryError('PARTIAL_PROVIDER_BATCH');
		return written;
	}

	// Must share the activation transaction so that a read switch cannot race an
	// old worker publishing an incompletely dual-written version.
	async assertVersionComplete(versionId: string, tx: Client) {
		await this.lockPolicy(tx);
		for (const version of (await this.policy(tx)).writeVersions) {
			const counts = await this.coverage(this.settings.profile(version), tx, versionId);
			if (!counts.total || counts.total !== counts.ready) {
				throw new EmbeddingTemporaryError('INCOMPLETE_EMBEDDINGS');
			}
		}
	}

	private lockPolicy(tx: Client) {
		return tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(413592, 10)`;
	}

	private async coverage(profile: EmbeddingProfile, db: Client, versionId?: string) {
		const scope =
			versionId === undefined
				? Prisma.sql`v.status = 'INDEXED'`
				: Prisma.sql`c."versionId" = ${versionId}`;
		const [counts] = await db.$queryRaw<{ total: number; ready: number }[]>`
			SELECT count(*)::int AS total, count(e.id)::int AS ready FROM "DocumentChunk" c
			JOIN "DocumentVersion" v ON v.id = c."versionId"
			LEFT JOIN "DocumentEmbedding" e ON e."chunkId" = c.id AND e."embeddingVersion" = ${profile.version}
				AND e.model = ${profile.model} AND e.status = 'READY'
			WHERE ${scope}`;
		return counts;
	}

	async rollout(action: string, version: string) {
		if (action === 'coverage') {
			const profile = this.settings.profile(version);
			return {
				version,
				...(await this.coverage(profile, this.db)),
				...(await this.policy(this.db)),
			};
		}
		if (action === 'backfill') {
			const profile = this.settings.profile(version);
			if (!(await this.policy(this.db)).writeVersions.includes(version))
				throw new Error('Enable dual-write first');
			const written = await this.fill(profile);
			return { version, written, ...(await this.coverage(profile, this.db)) };
		}
		return this.db.$transaction(async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(413592, 10)`;
			const policy = await this.policy(tx);
			switch (action) {
				case 'dual-write':
					this.settings.profile(version);
					policy.writeVersions = [...new Set([...policy.writeVersions, version])];
					break;
				case 'switch': {
					const profile = this.settings.profile(version);
					const counts = await this.coverage(profile, tx);
					if (!policy.writeVersions.includes(version) || counts.total !== counts.ready) {
						throw new Error('Read switch requires complete coverage and dual-write');
					}
					policy.embeddingVersion = version;
					break;
				}
				case 'retire':
					// Recovery may run after a Voyage key is revoked. A stored write profile
					// can be removed without constructing its provider or sending any content.
					assertValidEmbeddingVersion(version);
					if (!policy.writeVersions.includes(version)) this.settings.profile(version);
					if (policy.embeddingVersion === version)
						throw new Error('Cannot retire the read version');
					policy.writeVersions = policy.writeVersions.filter((item) => item !== version);
					break;
				case 'cleanup': {
					this.settings.profile(version);
					if (policy.embeddingVersion === version || policy.writeVersions.includes(version)) {
						throw new Error('Retire the version before cleanup');
					}
					const deleted =
						await tx.$executeRaw`DELETE FROM "DocumentEmbedding" WHERE "embeddingVersion" = ${version}`;
					return { version, deleted };
				}
				default:
					throw new Error('Unknown rollout command');
			}
			await tx.$executeRaw` INSERT INTO "EmbeddingReadConfig"(id, "embeddingVersion", "writeVersions")
				VALUES ('default', ${policy.embeddingVersion}, ARRAY[${Prisma.join(policy.writeVersions)}]::text[])
				ON CONFLICT (id) DO UPDATE SET "embeddingVersion" = EXCLUDED."embeddingVersion",
					"writeVersions" = EXCLUDED."writeVersions"`;
			return policy;
		});
	}
}
