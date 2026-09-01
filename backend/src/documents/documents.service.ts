import { BadRequestException, Injectable } from '@nestjs/common';
import { DocumentStatus } from '@prisma/client';
import { AccessPolicyService } from '../access/access-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';

@Injectable()
export class DocumentsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly accessPolicy: AccessPolicyService,
	) {}

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
