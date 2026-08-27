import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CreateWorkspaceDto, UpdateWorkspaceDto } from './dto/workspace.dto';
import { WorkspacesService } from './workspaces.service';

@Controller('workspaces')
export class WorkspacesController {
	constructor(private workspacesService: WorkspacesService) {}

	@UseGuards(AuthGuard('jwt'))
	@Get()
	list(@Req() request: any) {
		return this.workspacesService.list(request.user.sub);
	}

	@UseGuards(AuthGuard('jwt'))
	@Post()
	create(@Body() dto: CreateWorkspaceDto, @Req() request: any) {
		return this.workspacesService.create(request.user.sub, dto);
	}

	@UseGuards(AuthGuard('jwt'))
	@Get(':workspaceId')
	get(@Param('workspaceId') workspaceId: string, @Req() request: any) {
		return this.workspacesService.get(request.user.sub, workspaceId);
	}

	@UseGuards(AuthGuard('jwt'))
	@Patch(':workspaceId/archive')
	archive(@Param('workspaceId') workspaceId: string, @Req() request: any) {
		return this.workspacesService.archive(request.user.sub, workspaceId);
	}

	@UseGuards(AuthGuard('jwt'))
	@Patch(':workspaceId')
	update(
		@Param('workspaceId') workspaceId: string,
		@Body() dto: UpdateWorkspaceDto,
		@Req() request: any,
	) {
		return this.workspacesService.update(request.user.sub, workspaceId, dto);
	}

	@UseGuards(AuthGuard('jwt'))
	@Delete(':workspaceId')
	remove(@Param('workspaceId') workspaceId: string, @Req() request: any) {
		return this.workspacesService.remove(request.user.sub, workspaceId);
	}
}
