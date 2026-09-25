import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { DocumentsController } from './controllers/documents.controller';
import { ProjectDocumentsController } from './controllers/project-documents.controller';
import { DocumentAccessService } from './document-access.service';
import { DocumentsService } from './documents.service';

@Module({
	imports: [ProjectsModule],
	controllers: [DocumentsController, ProjectDocumentsController],
	providers: [DocumentsService, DocumentAccessService],
})
export class DocumentsModule {}
