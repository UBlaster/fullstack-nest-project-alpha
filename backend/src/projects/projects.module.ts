import { Module } from '@nestjs/common';
import { ProjectsController } from './controllers/projects.controller';
import { WorkspaceProjectsController } from './controllers/workspace-projects.controller';
import { ProjectAccessService } from './project-access.service';
import { ProjectsService } from './projects.service';

@Module({
	controllers: [ProjectsController, WorkspaceProjectsController],
	providers: [ProjectsService, ProjectAccessService],
	exports: [ProjectsService, ProjectAccessService],
})
export class ProjectsModule {}
