import { Body, Controller, Delete, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UpdateProjectDto } from './dto/project.dto';
import { ProjectsService } from './projects.service';

@Controller('projects')
export class ProjectsController {
	constructor(private projectsService: ProjectsService) {}

	@UseGuards(AuthGuard('jwt'))
	@Get()
	list(@Req() request: any) {
		return this.projectsService.list(request.user.sub);
	}

	@UseGuards(AuthGuard('jwt'))
	@Get(':projectId')
	get(@Param('projectId') projectId: string, @Req() request: any) {
		return this.projectsService.get(projectId, request.user.sub);
	}

	@UseGuards(AuthGuard('jwt'))
	@Patch(':projectId/archive')
	archive(@Param('projectId') projectId: string, @Req() request: any) {
		return this.projectsService.archive(projectId, request.user.sub);
	}

	@UseGuards(AuthGuard('jwt'))
	@Patch(':projectId')
	update(
		@Param('projectId') projectId: string,
		@Body() dto: UpdateProjectDto,
		@Req() request: any,
	) {
		return this.projectsService.update(projectId, request.user.sub, dto);
	}

	@UseGuards(AuthGuard('jwt'))
	@Delete(':projectId')
	remove(@Param('projectId') projectId: string, @Req() request: any) {
		return this.projectsService.remove(projectId, request.user.sub);
	}
}
