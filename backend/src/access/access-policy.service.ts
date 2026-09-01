import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessAction, AccessResource, assertAllowed } from './permissions';

@Injectable()
export class AccessPolicyService {
	constructor(private readonly prisma: PrismaService) {}

	private async requireMembership(
		userId: string,
		workspaceId: string,
		resource: AccessResource,
		action: AccessAction,
	) {
		const membership = await this.prisma.workspaceMember.findUnique({
			where: {
				userId_workspaceId: {
					userId,
					workspaceId,
				},
			},
		});

		if (!membership) {
			throw new NotFoundException();
		}

		assertAllowed(membership.role, resource, action);
		return membership;
	}

	async requireWorkspace(
		userId: string,
		workspaceId: string,
		action: AccessAction,
		resource: AccessResource = 'workspace',
	) {
		const workspace = await this.prisma.workspace.findUnique({
			where: { id: workspaceId },
		});

		if (!workspace) {
			throw new NotFoundException();
		}

		await this.requireMembership(userId, workspace.id, resource, action);
		return workspace;
	}

	async requireProject(
		userId: string,
		projectId: string,
		action: AccessAction,
		resource: AccessResource = 'project',
	) {
		const project = await this.prisma.project.findUnique({
			where: { id: projectId },
		});

		if (!project) {
			throw new NotFoundException();
		}

		await this.requireMembership(userId, project.workspaceId, resource, action);
		return project;
	}

	async requireDocument(userId: string, documentId: string, action: AccessAction) {
		const document = await this.prisma.document.findUnique({
			where: { id: documentId },
			include: {
				project: {
					select: { workspaceId: true },
				},
			},
		});

		if (!document) {
			throw new NotFoundException();
		}

		await this.requireMembership(userId, document.project.workspaceId, 'document', action);
		return document;
	}
}
