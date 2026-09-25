import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { StorageModule } from '../storage/storage.module';
import { ExportsController } from './controllers/exports.controller';
import { WorkspaceExportsController } from './controllers/workspace-exports.controller';
import { ExportsService } from './exports.service';
import { DocumentsModule } from '../documents/documents.module';

@Module({
	imports: [AccessModule, StorageModule, DocumentsModule],
	controllers: [ExportsController, WorkspaceExportsController],
	providers: [ExportsService],
})
export class ExportsModule {}
