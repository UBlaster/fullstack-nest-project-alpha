import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { DocumentsController } from './controllers/documents.controller';
import { ProjectDocumentsController } from './controllers/project-documents.controller';
import { WorkspaceDocumentsController } from './controllers/workspace-documents.controller';
import { DocumentsService } from './documents.service';

@Module({
	imports: [AccessModule],
	controllers: [DocumentsController, ProjectDocumentsController, WorkspaceDocumentsController],
	providers: [DocumentsService],
})
export class DocumentsModule {}
