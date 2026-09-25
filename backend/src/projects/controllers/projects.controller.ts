import { Body, Controller, Delete, Get, Param, Patch, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/authenticated-request';
import { JwtAuth } from '../../auth/decorators/jwt-auth.decorator';
import { UpdateProjectDto } from '../dto/update-project.dto';
import { ProjectsService } from '../projects.service';

@JwtAuth()
@Controller('projects')
export class ProjectsController {
	constructor(private readonly projectsService: ProjectsService) {}

	@Get()
	list(@Req() request: AuthenticatedRequest) {
		return this.projectsService.list(request.user.sub);
	}

	@Get(':projectId')
	get(@Param('projectId') projectId: string, @Req() request: AuthenticatedRequest) {
		return this.projectsService.get(request.user.sub, projectId);
	}

	@Patch(':projectId/archive')
	archive(@Param('projectId') projectId: string, @Req() request: AuthenticatedRequest) {
		return this.projectsService.archive(request.user.sub, projectId);
	}

	@Patch(':projectId')
	update(
		@Param('projectId') projectId: string,
		@Body() dto: UpdateProjectDto,
		@Req() request: AuthenticatedRequest,
	) {
		return this.projectsService.update(request.user.sub, projectId, dto);
	}

	@Delete(':projectId')
	remove(@Param('projectId') projectId: string, @Req() request: AuthenticatedRequest) {
		return this.projectsService.remove(request.user.sub, projectId);
	}
}
