import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Injectable()
export class ProjectsService {
	constructor(private readonly prisma: PrismaService) {}

	async ensureProjectAccess(id: string, userId: string) {
		const project = await this.prisma.project.findUnique({ where: { id } });
		if (!project) {
			throw new NotFoundException();
		}

		const membership = await this.prisma.workspaceMember.findUnique({
			where: { userId_workspaceId: { userId, workspaceId: project.workspaceId } },
		});
		if (!membership) {
			throw new NotFoundException();
		}

		return project;
	}

	async list(userId: string) {
		return this.prisma.project.findMany({
			where: { workspace: { members: { some: { userId } } } },
			include: {
				_count: { select: { documents: true } },
				createdBy: { select: { name: true } },
			},
			orderBy: { updatedAt: 'desc' },
		});
	}

	async get(id: string, userId: string) {
		const project = await this.ensureProjectAccess(id, userId);
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
		const membership = await this.prisma.workspaceMember.findUnique({
			where: { userId_workspaceId: { userId, workspaceId } },
		});
		if (!membership) {
			throw new NotFoundException();
		}

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
		if (dto.name === undefined && dto.description === undefined) {
			throw new BadRequestException('At least one field is required');
		}
		await this.ensureProjectAccess(id, userId);

		return this.prisma.project.update({
			where: { id },
			data: { name: dto.name, description: dto.description },
		});
	}

	async remove(id: string, userId: string) {
		await this.ensureProjectAccess(id, userId);
		return this.prisma.project.delete({ where: { id } });
	}
}
