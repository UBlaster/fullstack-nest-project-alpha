import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { StorageModule } from '../storage/storage.module';
import { DocumentFilesController } from './document-files.controller';
import { DocumentFilesService } from './document-files.service';

@Module({
	imports: [AccessModule, StorageModule],
	controllers: [DocumentFilesController],
	providers: [DocumentFilesService],
	exports: [DocumentFilesService],
})
export class DocumentFilesModule {}
