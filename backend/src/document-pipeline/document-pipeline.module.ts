import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { StorageModule } from '../storage/storage.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { DocumentVersionsService } from './document-versions.service';
import { DocumentVersionsController } from './document-versions.controller';
import { PipelineProcessorService } from './pipeline-processor.service';
import { PipelineContentService } from './pipeline-content.service';

@Module({
	imports: [AccessModule, StorageModule, EmbeddingsModule],
	controllers: [DocumentVersionsController],
	providers: [DocumentVersionsService, PipelineContentService, PipelineProcessorService],
	exports: [PipelineProcessorService],
})
export class DocumentPipelineModule {}
