import { Injectable } from '@nestjs/common';
import { ProjectStatus } from '@prisma/client';
import { AccessPolicyService } from '../access/access-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectDto, UpdateProjectDto } from './dto/project.dto';

@Injectable()
export class ProjectsService {
	constructor(
		private prisma: PrismaService,
		private accessPolicy: AccessPolicyService,
	) {}

	async list(userId: string) {
		return this.prisma.project.findMany({
			where: {
				workspace: {
					members: {
						some: {
							userId,
						},
					},
				},
			},
			include: {
				_count: {
					select: {
						documents: true,
					},
				},
				createdBy: {
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

	async listByWorkspace(workspaceId: string, userId: string) {
		await this.accessPolicy.requireWorkspace(userId, workspaceId, 'view');

		return this.prisma.project.findMany({
			where: {
				workspaceId,
			},
			include: {
				_count: {
					select: {
						documents: true,
					},
				},
				createdBy: {
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
		const project = await this.accessPolicy.requireProject(userId, id, 'view');

		return this.prisma.project.findUnique({
			where: {
				id: project.id,
			},
			include: {
				documents: {
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
				},
			},
		});
	}

	async create(workspaceId: string, userId: string, dto: CreateProjectDto) {
		await this.accessPolicy.requireWorkspace(userId, workspaceId, 'create', 'project');

		return this.prisma.project.create({
			data: {
				name: dto.name,
				description: dto.description,
				workspaceId,
				createdById: userId,
			},
		});
	}

	async update(id: string, userId: string, dto: UpdateProjectDto) {
		await this.accessPolicy.requireProject(userId, id, 'update');

		return this.prisma.project.update({
			where: {
				id,
			},
			data: {
				name: dto.name,
				description: dto.description,
			},
		});
	}

	async archive(id: string, userId: string) {
		await this.accessPolicy.requireProject(userId, id, 'archive');

		return this.prisma.project.update({
			where: {
				id,
			},
			data: {
				status: ProjectStatus.ARCHIVED,
			},
		});
	}

	async remove(id: string, userId: string) {
		await this.accessPolicy.requireProject(userId, id, 'delete');

		return this.prisma.project.delete({
			where: {
				id,
			},
		});
	}
}
