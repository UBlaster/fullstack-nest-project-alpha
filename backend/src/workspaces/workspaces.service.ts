import { BadRequestException, Injectable } from '@nestjs/common';
import { WorkspaceRole, WorkspaceStatus } from '@prisma/client';
import { AccessPolicyService } from '../access/access-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';

@Injectable()
export class WorkspacesService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly accessPolicy: AccessPolicyService,
	) {}

	list(userId: string) {
		return this.prisma.workspace.findMany({
			where: {
				members: {
					some: { userId },
				},
			},
			orderBy: { updatedAt: 'desc' },
		});
	}

	create(userId: string, dto: CreateWorkspaceDto) {
		return this.prisma.workspace.create({
			data: {
				name: dto.name,
				members: {
					create: {
						userId,
						role: WorkspaceRole.OWNER,
					},
				},
			},
		});
	}

	get(userId: string, workspaceId: string) {
		return this.accessPolicy.requireWorkspace(userId, workspaceId, 'view');
	}

	async update(userId: string, workspaceId: string, dto: UpdateWorkspaceDto) {
		await this.accessPolicy.requireWorkspace(userId, workspaceId, 'update');

		if (dto.name === undefined) {
			throw new BadRequestException('At least one field is required');
		}

		return this.prisma.workspace.update({
			where: { id: workspaceId },
			data: { name: dto.name },
		});
	}

	async archive(userId: string, workspaceId: string) {
		await this.accessPolicy.requireWorkspace(userId, workspaceId, 'archive');
		return this.prisma.workspace.update({
			where: { id: workspaceId },
			data: { status: WorkspaceStatus.ARCHIVED },
		});
	}

	async remove(userId: string, workspaceId: string) {
		await this.accessPolicy.requireWorkspace(userId, workspaceId, 'delete');
		return this.prisma.workspace.delete({
			where: { id: workspaceId },
		});
	}
}
