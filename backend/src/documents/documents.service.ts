import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { DocumentAccessService } from './document-access.service';

@Injectable()
export class DocumentsService {
	constructor(
		private prisma: PrismaService,
		private projectAccess: ProjectAccessService,
		private documentAccess: DocumentAccessService,
	) {}

	async list(projectId: string, userId: string) {
		const project = await this.prisma.project.findUnique({
			where: {
				id: projectId,
			},
		});

		if (!project) {
			throw new NotFoundException();
		}

		await this.projectAccess.ensureProjectAccess(projectId, userId);

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
		await this.documentAccess.ensureDocumentAccess(id, userId);

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

	async create(projectId: string, userId: string, data: any) {
		await this.projectAccess.ensureProjectAccess(projectId, userId);

		return this.prisma.document.create({
			data: {
				...data,
				projectId,
				authorId: userId,
			},
		});
	}

	async update(id: string, userId: string, data: any) {
		await this.documentAccess.ensureDocumentAccess(id, userId);

		return this.prisma.document.update({
			where: {
				id,
			},
			data,
		});
	}

	async remove(id: string, userId: string) {
		await this.documentAccess.ensureDocumentAccess(id, userId);

		return this.prisma.document.delete({
			where: {
				id,
			},
		});
	}
}
