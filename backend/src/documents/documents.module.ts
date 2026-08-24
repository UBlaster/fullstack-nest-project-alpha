import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
	imports: [ProjectsModule],
	controllers: [DocumentsController],
	providers: [DocumentsService],
})
export class DocumentsModule {}
