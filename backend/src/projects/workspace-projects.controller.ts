import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CreateProjectDto } from './dto/project.dto';
import { ProjectsService } from './projects.service';

@Controller('workspaces/:workspaceId/projects')
export class WorkspaceProjectsController {
	constructor(private projectsService: ProjectsService) {}

	@UseGuards(AuthGuard('jwt'))
	@Get()
	list(@Param('workspaceId') workspaceId: string, @Req() request: any) {
		return this.projectsService.listByWorkspace(workspaceId, request.user.sub);
	}

	@UseGuards(AuthGuard('jwt'))
	@Post()
	create(
		@Param('workspaceId') workspaceId: string,
		@Body() dto: CreateProjectDto,
		@Req() request: any,
	) {
		return this.projectsService.create(workspaceId, request.user.sub, dto);
	}
}
