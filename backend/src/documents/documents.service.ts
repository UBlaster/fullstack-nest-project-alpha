import { Injectable } from '@nestjs/common';
import { DocumentStatus } from '@prisma/client';
import { AccessPolicyService } from '../access/access-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDocumentDto, UpdateDocumentDto } from './dto/document.dto';

@Injectable()
export class DocumentsService {
	constructor(
		private prisma: PrismaService,
		private accessPolicy: AccessPolicyService,
	) {}

	async list(projectId: string, userId: string) {
		await this.accessPolicy.requireProject(userId, projectId, 'view');

		return this.prisma.document.findMany({
			where: {
				projectId,
			},
			include: {
				author: {
					select: {
						name: true,
					},
				},
			},
			orderBy: {
				updatedAt: 'desc',
			},
		});
	}

	async get(id: string, userId: string) {
		await this.accessPolicy.requireDocument(userId, id, 'view');

		return this.prisma.document.findUnique({
			where: {
				id,
			},
			include: {
				author: {
					select: {
						name: true,
					},
				},
				project: true,
			},
		});
	}

	async create(projectId: string, userId: string, dto: CreateDocumentDto) {
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

	async update(id: string, userId: string, dto: UpdateDocumentDto) {
		await this.accessPolicy.requireDocument(userId, id, 'update');

		return this.prisma.document.update({
			where: {
				id,
			},
			data: {
				title: dto.title,
				content: dto.content,
			},
		});
	}

	async archive(id: string, userId: string) {
		await this.accessPolicy.requireDocument(userId, id, 'archive');

		return this.prisma.document.update({
			where: {
				id,
			},
			data: {
				status: DocumentStatus.ARCHIVED,
			},
		});
	}

	async remove(id: string, userId: string) {
		await this.accessPolicy.requireDocument(userId, id, 'delete');

		return this.prisma.document.delete({
			where: {
				id,
			},
		});
	}
}
