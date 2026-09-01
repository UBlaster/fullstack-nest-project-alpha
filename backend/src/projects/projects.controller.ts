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

	@Get('projects/:projectId')
	get(@Param('projectId') projectId: string, @Req() request: AuthenticatedRequest) {
		return this.projectsService.get(projectId, request.user.sub);
	}

	@Post('workspaces/:workspaceId/projects')
	create(
		@Param('workspaceId') workspaceId: string,
		@Body() dto: CreateProjectDto,
		@Req() request: AuthenticatedRequest,
	) {
		return this.projectsService.create(request.user.sub, workspaceId, dto);
	}

	@Patch('projects/:projectId')
	update(
		@Param('projectId') projectId: string,
		@Body() dto: UpdateProjectDto,
		@Req() request: AuthenticatedRequest,
	) {
		return this.projectsService.update(projectId, request.user.sub, dto);
	}

	@Delete('projects/:projectId')
	remove(@Param('projectId') projectId: string, @Req() request: AuthenticatedRequest) {
		return this.projectsService.remove(projectId, request.user.sub);
	}
}
