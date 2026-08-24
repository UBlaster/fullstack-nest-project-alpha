import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
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
	@Get(':id')
	get(@Param('id') id: string, @Req() request: any) {
		return this.projectsService.get(id, request.user.sub);
	}

	@UseGuards(AuthGuard('jwt'))
	@Post()
	create(@Body() data: any, @Req() request: any) {
		return this.projectsService.create(request.user.sub, data);
	}

	@UseGuards(AuthGuard('jwt'))
	@Patch(':id')
	update(@Param('id') id: string, @Body() data: any, @Req() request: any) {
		return this.projectsService.update(id, request.user.sub, data);
	}

	@UseGuards(AuthGuard('jwt'))
	@Delete(':id')
	remove(@Param('id') id: string, @Req() request: any) {
		return this.projectsService.remove(id, request.user.sub);
	}
}
