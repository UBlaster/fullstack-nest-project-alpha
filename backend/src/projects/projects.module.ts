import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { WorkspaceProjectsController } from './workspace-projects.controller';

@Module({
	imports: [AccessModule],
	controllers: [ProjectsController, WorkspaceProjectsController],
	providers: [ProjectsService],
})
export class ProjectsModule {}
