import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProjectsService {
	constructor(private prisma: PrismaService) {}

	async ensureProjectAccess(id: string, userId: string) {
		const project = await this.prisma.project.findUnique({
			where: {
				id,
			},
		});

		if (!project) {
			throw new NotFoundException();
		}

		const membership = await this.prisma.workspaceMember.findUnique({
			where: {
				userId_workspaceId: {
					userId,
					workspaceId: project.workspaceId,
				},
			},
		});

		if (!membership) {
			throw new NotFoundException();
		}

		return project;
	}

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

	async get(id: string, userId: string) {
		const project = await this.ensureProjectAccess(id, userId);

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

	async create(userId: string, data: any) {
		const membership = await this.prisma.workspaceMember.findFirst({
			where: {
				userId,
			},
		});

		if (!membership) {
			throw new NotFoundException();
		}

		return this.prisma.project.create({
			data: {
				...data,
				workspaceId: membership.workspaceId,
				createdById: userId,
			},
		});
	}

	async update(id: string, userId: string, data: any) {
		await this.ensureProjectAccess(id, userId);

		return this.prisma.project.update({
			where: {
				id,
			},
			data,
		});
	}

	async remove(id: string, userId: string) {
		await this.ensureProjectAccess(id, userId);

		return this.prisma.project.delete({
			where: {
				id,
			},
		});
	}
}
