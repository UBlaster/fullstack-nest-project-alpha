import { ForbiddenException } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';

export type AccessAction = 'view' | 'create' | 'update' | 'archive' | 'delete';
export type AccessResource = 'workspace' | 'project' | 'document';

const workspacePermissions: Record<AccessAction, WorkspaceRole[]> = {
	view: ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
	create: ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
	update: ['OWNER', 'ADMIN'],
	archive: ['OWNER'],
	delete: ['OWNER'],
};

const projectPermissions: Record<AccessAction, WorkspaceRole[]> = {
	view: ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
	create: ['OWNER', 'ADMIN', 'MEMBER'],
	update: ['OWNER', 'ADMIN', 'MEMBER'],
	archive: ['OWNER', 'ADMIN', 'MEMBER'],
	delete: ['OWNER', 'ADMIN'],
};

const documentPermissions: Record<AccessAction, WorkspaceRole[]> = {
	view: ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
	create: ['OWNER', 'ADMIN', 'MEMBER'],
	update: ['OWNER', 'ADMIN', 'MEMBER'],
	archive: ['OWNER', 'ADMIN', 'MEMBER'],
	delete: ['OWNER', 'ADMIN'],
};

export const permissions: Record<AccessResource, Record<AccessAction, WorkspaceRole[]>> = {
	workspace: workspacePermissions,
	project: projectPermissions,
	document: documentPermissions,
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
