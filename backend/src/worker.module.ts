import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessModule } from './access/access.module';
import { DocumentsExportService } from './documents/documents-export.service';
import { ExportMaintenanceService } from './exports/export-maintenance.service';
import { ExportProcessorService } from './exports/export-processor.service';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';
import { WorkerRuntimeService } from './worker-runtime.service';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		PrismaModule,
		AccessModule,
		StorageModule,
		QueueModule,
	],
	providers: [
		DocumentsExportService,
		ExportProcessorService,
		ExportMaintenanceService,
		WorkerRuntimeService,
	],
})
export class WorkerModule {}
