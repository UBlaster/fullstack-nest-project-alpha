import { BadRequestException, Injectable } from '@nestjs/common';
import { ProjectStatus } from '@prisma/client';
import { AccessPolicyService } from '../access/access-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Injectable()
export class ProjectsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly accessPolicy: AccessPolicyService,
	) {}

	list(userId: string) {
		return this.prisma.project.findMany({
			where: { workspace: { members: { some: { userId } } } },
			include: {
				_count: { select: { documents: true } },
				createdBy: { select: { name: true } },
			},
			orderBy: { updatedAt: 'desc' },
		});
	}

	async listByWorkspace(userId: string, workspaceId: string) {
		await this.accessPolicy.requireWorkspace(userId, workspaceId, 'view', 'project');
		return this.prisma.project.findMany({
			where: { workspaceId },
			include: {
				_count: { select: { documents: true } },
				createdBy: { select: { name: true } },
			},
			orderBy: { updatedAt: 'desc' },
		});
	}

	async get(userId: string, projectId: string) {
		const project = await this.accessPolicy.requireProject(userId, projectId, 'view');
		return this.prisma.project.findUnique({
			where: { id: project.id },
			include: {
				documents: {
					include: { author: { select: { name: true } } },
					orderBy: { updatedAt: 'desc' },
				},
			},
		});
	}

	async create(userId: string, workspaceId: string, dto: CreateProjectDto) {
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

	async update(userId: string, projectId: string, dto: UpdateProjectDto) {
		await this.accessPolicy.requireProject(userId, projectId, 'update');

		if (dto.name === undefined && dto.description === undefined) {
			throw new BadRequestException('At least one field is required');
		}

		return this.prisma.project.update({
			where: { id: projectId },
			data: {
				name: dto.name,
				description: dto.description,
			},
		});
	}

	async archive(userId: string, projectId: string) {
		await this.accessPolicy.requireProject(userId, projectId, 'archive');
		return this.prisma.project.update({
			where: { id: projectId },
			data: { status: ProjectStatus.ARCHIVED },
		});
	}

	async remove(userId: string, projectId: string) {
		await this.accessPolicy.requireProject(userId, projectId, 'delete');
		return this.prisma.project.delete({
			where: { id: projectId },
		});
	}
}
