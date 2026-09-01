import { ForbiddenException } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';

export type AccessAction = 'view' | 'create' | 'update' | 'archive' | 'delete';
export type AccessResource = 'workspace' | 'project' | 'document';

export const permissions: Record<AccessResource, Record<AccessAction, readonly WorkspaceRole[]>> = {
	workspace: {
		view: [WorkspaceRole.OWNER, WorkspaceRole.MEMBER, WorkspaceRole.VIEWER],
		create: [WorkspaceRole.OWNER, WorkspaceRole.MEMBER, WorkspaceRole.VIEWER],
		update: [WorkspaceRole.OWNER],
		archive: [WorkspaceRole.OWNER],
		delete: [WorkspaceRole.OWNER],
	},
	project: {
		view: [WorkspaceRole.OWNER, WorkspaceRole.MEMBER, WorkspaceRole.VIEWER],
		create: [WorkspaceRole.OWNER, WorkspaceRole.MEMBER],
		update: [WorkspaceRole.OWNER, WorkspaceRole.MEMBER],
		archive: [WorkspaceRole.OWNER, WorkspaceRole.MEMBER],
		delete: [WorkspaceRole.OWNER],
	},
	document: {
		view: [WorkspaceRole.OWNER, WorkspaceRole.MEMBER, WorkspaceRole.VIEWER],
		create: [WorkspaceRole.OWNER, WorkspaceRole.MEMBER],
		update: [WorkspaceRole.OWNER, WorkspaceRole.MEMBER],
		archive: [WorkspaceRole.OWNER, WorkspaceRole.MEMBER],
		delete: [WorkspaceRole.OWNER],
	},
};

export function assertAllowed(
	role: WorkspaceRole,
	resource: AccessResource,
	action: AccessAction,
): void {
	if (!permissions[resource][action].includes(role)) {
		throw new ForbiddenException();
	}
}
