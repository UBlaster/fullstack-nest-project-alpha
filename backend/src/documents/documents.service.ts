import { BadRequestException, Injectable } from '@nestjs/common';
import { DocumentStatus } from '@prisma/client';
import { AccessPolicyService } from '../access/access-policy.service';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { SearchDocumentsQueryDto } from './dto/search-documents-query.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';

const searchSimilarityThreshold = '0.3';

interface SearchDocumentRow {
	id: string;
	projectId: string;
	title: string;
	status: DocumentStatus;
	updatedAt: Date;
	authorName: string;
	score: number;
}

@Injectable()
export class DocumentsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly accessPolicy: AccessPolicyService,
		private readonly cache: CacheService,
	) {}

	async search(userId: string, workspaceId: string, dto: SearchDocumentsQueryDto) {
		await this.accessPolicy.requireWorkspace(userId, workspaceId, 'view', 'document');
		const load = async () => {
			const rows = await this.prisma.$transaction(async (transaction) => {
				await transaction.$queryRaw`
				SELECT
					set_config(
						'pg_trgm.similarity_threshold',
						${searchSimilarityThreshold},
						true
					),
					set_config(
						'pg_trgm.word_similarity_threshold',
						${searchSimilarityThreshold},
						true
					)
			`;

				return transaction.$queryRaw<SearchDocumentRow[]>`
				SELECT
					document."id",
					document."projectId",
					document."title",
					document."status",
					document."updatedAt",
					author."name" AS "authorName",
					GREATEST(
						similarity(document."title", ${dto.q}),
						word_similarity(${dto.q}, document."title")
					)::real AS "score"
				FROM "Document" AS document
				JOIN "Project" AS project
					ON project."id" = document."projectId"
				JOIN "User" AS author
					ON author."id" = document."authorId"
				WHERE
					project."workspaceId" = ${workspaceId}
					AND (
						document."title" % ${dto.q}
						OR ${dto.q} <% document."title"
					)
				ORDER BY
					"score" DESC,
					document."updatedAt" DESC,
					document."id" ASC
				LIMIT ${dto.limit}
				OFFSET ${dto.offset}
				`;
			});

			return rows.map((row) => ({
				id: row.id,
				projectId: row.projectId,
				title: row.title,
				status: row.status,
				updatedAt: row.updatedAt,
				author: { name: row.authorName },
				score: row.score,
			}));
		};
		const version = await this.cache.getWorkspaceVersion(workspaceId);
		if (version === null) return load();
		const key = this.cache.searchKey(workspaceId, version, dto);
		return this.cache.remember(key, this.cache.searchTtlSeconds, load);
	}

	async list(userId: string, projectId: string) {
		await this.accessPolicy.requireProject(userId, projectId, 'view', 'document');
		return this.prisma.document.findMany({
			where: { projectId },
			include: {
				author: {
					select: { name: true },
				},
			},
			orderBy: { updatedAt: 'desc' },
		});
	}

	async get(userId: string, documentId: string) {
		await this.accessPolicy.requireDocument(userId, documentId, 'view');
		return this.prisma.document.findUnique({
			where: { id: documentId },
			include: {
				author: {
					select: { name: true },
				},
				project: true,
			},
		});
	}

	async create(userId: string, projectId: string, dto: CreateDocumentDto) {
		const context = await this.accessPolicy.requireProject(userId, projectId, 'create', 'document');
		const document = await this.prisma.document.create({
			data: {
				title: dto.title,
				content: dto.content,
				projectId,
				authorId: userId,
			},
		});
		await this.cache.invalidateWorkspace(context.workspaceId);
		return document;
	}

	async update(userId: string, documentId: string, dto: UpdateDocumentDto) {
		const context = await this.accessPolicy.requireDocument(userId, documentId, 'update');

		if (dto.title === undefined && dto.content === undefined) {
			throw new BadRequestException('At least one field is required');
		}

		const document = await this.prisma.document.update({
			where: { id: documentId },
			data: {
				title: dto.title,
				content: dto.content,
			},
		});
		await this.cache.invalidateWorkspace(context.project.workspaceId);
		return document;
	}

	async archive(userId: string, documentId: string) {
		const context = await this.accessPolicy.requireDocument(userId, documentId, 'archive');
		const document = await this.prisma.document.update({
			where: { id: documentId },
			data: { status: DocumentStatus.ARCHIVED },
		});
		await this.cache.invalidateWorkspace(context.project.workspaceId);
		return document;
	}

	async remove(userId: string, documentId: string) {
		const context = await this.accessPolicy.requireDocument(userId, documentId, 'delete');
		const document = await this.prisma.document.delete({
			where: { id: documentId },
		});
		await this.cache.invalidateWorkspace(context.project.workspaceId);
		return document;
	}
}
