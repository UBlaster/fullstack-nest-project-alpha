import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { StorageModule } from '../storage/storage.module';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';
import { DocumentsModule } from '../documents/documents.module';

@Module({
	imports: [AccessModule, StorageModule, DocumentsModule],
	controllers: [ExportsController],
	providers: [ExportsService],
})
export class ExportsModule {}
