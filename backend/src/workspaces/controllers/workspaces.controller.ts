import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/authenticated-request';
import { JwtAuth } from '../../auth/decorators/jwt-auth.decorator';
import { CreateWorkspaceDto } from '../dto/create-workspace.dto';
import { UpdateWorkspaceDto } from '../dto/update-workspace.dto';
import { WorkspacesService } from '../workspaces.service';

@JwtAuth()
@Controller('workspaces')
export class WorkspacesController {
	constructor(private readonly workspacesService: WorkspacesService) {}

	@Get()
	list(@Req() request: AuthenticatedRequest) {
		return this.workspacesService.list(request.user.sub);
	}

	@Post()
	create(@Body() dto: CreateWorkspaceDto, @Req() request: AuthenticatedRequest) {
		return this.workspacesService.create(request.user.sub, dto);
	}

	@Get(':workspaceId')
	get(@Param('workspaceId') workspaceId: string, @Req() request: AuthenticatedRequest) {
		return this.workspacesService.get(request.user.sub, workspaceId);
	}

	@Patch(':workspaceId/archive')
	archive(@Param('workspaceId') workspaceId: string, @Req() request: AuthenticatedRequest) {
		return this.workspacesService.archive(request.user.sub, workspaceId);
	}

	@Patch(':workspaceId')
	update(
		@Param('workspaceId') workspaceId: string,
		@Body() dto: UpdateWorkspaceDto,
		@Req() request: AuthenticatedRequest,
	) {
		return this.workspacesService.update(request.user.sub, workspaceId, dto);
	}

	@Delete(':workspaceId')
	remove(@Param('workspaceId') workspaceId: string, @Req() request: AuthenticatedRequest) {
		return this.workspacesService.remove(request.user.sub, workspaceId);
	}
}
