import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthenticatedRequest } from '../auth/authenticated-request';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectsService } from './projects.service';

@UseGuards(AuthGuard('jwt'))
@Controller()
export class ProjectsController {
	constructor(private readonly projectsService: ProjectsService) {}

	@Get('projects')
	list(@Req() request: AuthenticatedRequest) {
		return this.projectsService.list(request.user.sub);
	}

	@Get('workspaces/:workspaceId/projects')
	listByWorkspace(@Param('workspaceId') workspaceId: string, @Req() request: AuthenticatedRequest) {
		return this.projectsService.listByWorkspace(request.user.sub, workspaceId);
	}

	@Get('projects/:projectId')
	get(@Param('projectId') projectId: string, @Req() request: AuthenticatedRequest) {
		return this.projectsService.get(request.user.sub, projectId);
	}

	@Post('workspaces/:workspaceId/projects')
	create(
		@Param('workspaceId') workspaceId: string,
		@Body() dto: CreateProjectDto,
		@Req() request: AuthenticatedRequest,
	) {
		return this.projectsService.create(request.user.sub, workspaceId, dto);
	}

	@Patch('projects/:projectId/archive')
	archive(@Param('projectId') projectId: string, @Req() request: AuthenticatedRequest) {
		return this.projectsService.archive(request.user.sub, projectId);
	}

	@Patch('projects/:projectId')
	update(
		@Param('projectId') projectId: string,
		@Body() dto: UpdateProjectDto,
		@Req() request: AuthenticatedRequest,
	) {
		return this.projectsService.update(request.user.sub, projectId, dto);
	}

	@Delete('projects/:projectId')
	remove(@Param('projectId') projectId: string, @Req() request: AuthenticatedRequest) {
		return this.projectsService.remove(request.user.sub, projectId);
	}
}
