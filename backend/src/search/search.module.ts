import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { SearchController } from './search.controller';
import { HybridSearchService } from './search.service';
@Module({
	imports: [AccessModule, EmbeddingsModule],
	controllers: [SearchController],
	providers: [HybridSearchService],
})
export class SearchModule {}
