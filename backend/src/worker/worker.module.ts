import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessModule } from '../access/access.module';
import { DocumentsExportService } from '../documents/documents-export.service';
import { ExportMaintenanceService } from './export-maintenance.service';
import { ExportProcessorService } from './export-processor.service';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { WorkerRuntimeService } from './worker-runtime.service';
import { PaymentsModule } from '../payments/payments.module';
import { DocumentPipelineModule } from '../document-pipeline/document-pipeline.module';
import { OutboxPublisherService } from '../outbox/outbox-publisher.service';
import { PipelineWorkerService } from './pipeline-worker.service';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		PrismaModule,
		AccessModule,
		StorageModule,
		QueueModule,
		PaymentsModule,
		DocumentPipelineModule,
	],
	providers: [
		DocumentsExportService,
		ExportProcessorService,
		ExportMaintenanceService,
		WorkerRuntimeService,
		PipelineWorkerService,
		OutboxPublisherService,
	],
})
export class WorkerModule {}
