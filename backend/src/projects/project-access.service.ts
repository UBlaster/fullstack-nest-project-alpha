import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProjectAccessService {
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

	async ensureWorkspaceAccess(workspaceId: string, userId: string) {
		const membership = await this.prisma.workspaceMember.findUnique({
			where: { userId_workspaceId: { userId, workspaceId } },
		});
		if (!membership) {
			throw new NotFoundException();
		}
	}
}
