import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';

@Injectable()
export class DocumentsService {
	constructor(
		private prisma: PrismaService,
		private projectsService: ProjectsService,
	) {}

	private async ensureDocumentAccess(id: string, userId: string) {
		const document = await this.prisma.document.findUnique({
			where: {
				id,
			},
			include: {
				project: true,
			},
		});

		if (!document) {
			throw new NotFoundException();
		}

		const membership = await this.prisma.workspaceMember.findUnique({
			where: {
				userId_workspaceId: {
					userId,
					workspaceId: document.project.workspaceId,
				},
			},
		});

		if (!membership) {
			throw new NotFoundException();
		}

		return document;
	}

	async list(projectId: string, userId: string) {
		const project = await this.prisma.project.findUnique({
			where: {
				id: projectId,
			},
		});

		if (!project) {
			throw new NotFoundException();
		}

		await this.projectsService.ensureProjectAccess(projectId, userId);

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
		await this.ensureDocumentAccess(id, userId);

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
		await this.projectsService.ensureProjectAccess(projectId, userId);

		return this.prisma.document.create({
			data: {
				...data,
				projectId,
				authorId: userId,
			},
		});
	}

	async update(id: string, userId: string, data: any) {
		await this.ensureDocumentAccess(id, userId);

		return this.prisma.document.update({
			where: {
				id,
			},
			data,
		});
	}

	async remove(id: string, userId: string) {
		await this.ensureDocumentAccess(id, userId);

		return this.prisma.document.delete({
			where: {
				id,
			},
		});
	}
}
