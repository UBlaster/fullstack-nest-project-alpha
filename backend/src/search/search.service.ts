import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessPolicyService } from '../access/access-policy.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { secondsHistogram, meter, withSpan } from '../observability/telemetry';
import { PrismaService } from '../prisma/prisma.service';
import { HybridSearchQuery } from './search.controller.dto';

const duration = meter.createHistogram('hybrid.search.duration', secondsHistogram);

export type SearchCandidate = {
	documentId: string;
	title: string;
	projectId: string;
	updatedAt: Date;
	snippet: string;
	score: number;
};
type Match = 'lexical' | 'semantic';

export function rankDocuments(
	lexical: SearchCandidate[],
	semantic: SearchCandidate[],
	limit: number,
) {
	const hits = new Map<
		string,
		{
			documentId: string;
			title: string;
			projectId: string;
			updatedAt: Date;
			snippet: string;
			matchedBy: Match[];
			scores: { rrf: number; lexical: number | null; semantic: number | null };
		}
	>();
	for (const [source, list] of [
		['lexical', lexical],
		['semantic', semantic],
	] as const) {
		list.forEach(({ score, ...candidate }, index) => {
			const hit = hits.get(candidate.documentId) ?? {
				...candidate,
				matchedBy: [],
				scores: { rrf: 0, lexical: null, semantic: null },
			};
			hit.scores.rrf += 1 / (60 + index + 1);
			hit.scores[source] = score;
			hit.matchedBy.push(source);
			if (source === 'semantic') hit.snippet = candidate.snippet;
			hits.set(candidate.documentId, hit);
		});
	}
	return [...hits.values()]
		.sort(
			(a, b) =>
				b.scores.rrf - a.scores.rrf ||
				(b.scores.lexical ?? -1) - (a.scores.lexical ?? -1) ||
				a.documentId.localeCompare(b.documentId),
		)
		.slice(0, limit);
}

@Injectable()
export class HybridSearchService {
	constructor(
		private readonly db: PrismaService,
		private readonly access: AccessPolicyService,
		private readonly embeddings: EmbeddingsService,
	) {}

	async search(userId: string, workspaceId: string, { q, limit }: HybridSearchQuery) {
		await this.access.requireWorkspace(userId, workspaceId, 'view', 'document');
		const start = performance.now();
		try {
			return await withSpan('search.hybrid', async (span) => {
				const { embeddingVersion, model, literal } = await this.embeddings.queryEmbedding(q);
				// Each retrieval contains the same membership, workspace and current-version joins.
				const accessible = Prisma.sql` FROM "Document" d
					JOIN "Project" p ON p.id = d."projectId" AND p."workspaceId" = ${workspaceId}
					JOIN "WorkspaceMember" m ON m."workspaceId" = p."workspaceId" AND m."userId" = ${userId}
					JOIN "DocumentVersion" v ON v.id = d."currentVersionId" AND v."documentId" = d.id AND v.status = 'INDEXED' `;
				const metadata = Prisma.sql`d.id AS "documentId", d.title, d."projectId", d."updatedAt"`;
				// Even a short chunk contributes an excerpt only.
				const snippet = Prisma.sql`left(hit.text, least(160, greatest(0, length(hit.text) - 1))) || '…' AS snippet`;
				const eligibleEmbeddings = Prisma.sql`${accessible}
					JOIN "DocumentChunk" hit ON hit."versionId" = v.id
					JOIN "DocumentEmbedding" e ON e."chunkId" = hit.id
					WHERE e."embeddingVersion" = ${embeddingVersion} AND e.model = ${model} AND e.status = 'READY'`;
				const distance = Prisma.sql`e.embedding <=> ${literal}::vector`;
				const [lexical, semantic] = await this.db.$transaction(
					async (tx) => {
						await tx.$executeRaw`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
						const titles = await tx.$queryRaw<SearchCandidate[]>`
						SELECT ${metadata}, ${snippet}, similarity(d.title, ${q}) AS score
						${accessible}
						JOIN LATERAL (SELECT c.text FROM "DocumentChunk" c WHERE c."versionId" = v.id
							ORDER BY c."chunkIndex" LIMIT 1) hit ON true
						WHERE d.title % ${q}
						ORDER BY score DESC, d.id LIMIT ${limit}`;
						// ORDER BY the distance operator directly so PostgreSQL can use HNSW.
						// The joins and predicates apply before either retrieval limit.
						const nearest = await tx.$queryRaw<SearchCandidate[]>`
						WITH candidates AS MATERIALIZED (
							SELECT ${metadata}, ${snippet}, ${distance} AS distance
							${eligibleEmbeddings}
							ORDER BY ${distance} LIMIT ${2 * limit}
						), best AS (
							SELECT DISTINCT ON ("documentId") * FROM candidates WHERE distance < 1
							ORDER BY "documentId", distance, snippet
						) SELECT "documentId", title, "projectId", "updatedAt", snippet, 1 - distance AS score
						FROM best ORDER BY distance, "documentId" LIMIT ${limit}`;
						span.setAttribute('search.vector.fallback', nearest.length < limit);
						if (nearest.length === limit) return [titles, nearest];
						// A single long document or a selective tenant can exhaust the ANN scan.
						// Rank the eligible corpus exactly only when it underfills the result.
						const exact = await tx.$queryRaw<SearchCandidate[]>`
						WITH best AS (
							SELECT DISTINCT ON (d.id) ${metadata}, ${snippet}, ${distance} AS distance
							${eligibleEmbeddings}
							ORDER BY d.id, ${distance}, hit."chunkIndex"
						) SELECT "documentId", title, "projectId", "updatedAt", snippet, 1 - distance AS score
						FROM best WHERE distance < 1 ORDER BY distance, "documentId" LIMIT ${limit}`;
						return [titles, exact];
					},
					{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 },
				);
				return { embeddingVersion, items: rankDocuments(lexical, semantic, limit) };
			});
		} finally {
			duration.record((performance.now() - start) / 1000);
		}
	}
}
