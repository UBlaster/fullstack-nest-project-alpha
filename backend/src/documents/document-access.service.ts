import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DocumentAccessService {
	constructor(private readonly prisma: PrismaService) {}

	async ensureDocumentAccess(id: string, userId: string) {
		const document = await this.prisma.document.findUnique({
			where: { id },
			include: { project: true },
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
}
