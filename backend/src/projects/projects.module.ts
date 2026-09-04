import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CacheModule } from '../cache/cache.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
	imports: [AccessModule, CacheModule],
	controllers: [ProjectsController],
	providers: [ProjectsService],
})
export class ProjectsModule {}
