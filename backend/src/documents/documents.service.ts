import { BadRequestException, Injectable } from '@nestjs/common';
import { DocumentStatus } from '@prisma/client';
import { AccessPolicyService } from '../access/access-policy.service';
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
	) {}

	async search(userId: string, workspaceId: string, dto: SearchDocumentsQueryDto) {
		await this.accessPolicy.requireWorkspace(userId, workspaceId, 'view', 'document');

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
		await this.accessPolicy.requireProject(userId, projectId, 'create', 'document');
		return this.prisma.document.create({
			data: {
				title: dto.title,
				content: dto.content,
				projectId,
				authorId: userId,
			},
		});
	}

	async update(userId: string, documentId: string, dto: UpdateDocumentDto) {
		await this.accessPolicy.requireDocument(userId, documentId, 'update');

		if (dto.title === undefined && dto.content === undefined) {
			throw new BadRequestException('At least one field is required');
		}

		return this.prisma.document.update({
			where: { id: documentId },
			data: {
				title: dto.title,
				content: dto.content,
			},
		});
	}

	async archive(userId: string, documentId: string) {
		await this.accessPolicy.requireDocument(userId, documentId, 'archive');
		return this.prisma.document.update({
			where: { id: documentId },
			data: { status: DocumentStatus.ARCHIVED },
		});
	}

	async remove(userId: string, documentId: string) {
		await this.accessPolicy.requireDocument(userId, documentId, 'delete');
		return this.prisma.document.delete({
			where: { id: documentId },
		});
	}
}
