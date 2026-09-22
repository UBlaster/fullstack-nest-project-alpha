import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { StorageModule } from '../storage/storage.module';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';
import { DocumentsModule } from '../documents/documents.module';
import { ExportMaintenanceService } from './export-maintenance.service';
import { ExportProcessorService } from './export-processor.service';

@Module({
	imports: [AccessModule, StorageModule, DocumentsModule],
	controllers: [ExportsController],
	providers: [ExportsService, ExportProcessorService, ExportMaintenanceService],
	exports: [ExportsService, ExportProcessorService, ExportMaintenanceService],
})
export class ExportsModule {}
