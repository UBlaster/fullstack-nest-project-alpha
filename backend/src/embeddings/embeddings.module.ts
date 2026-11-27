import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EmbeddingSettings } from './embedding-settings';
import { EmbeddingsService } from './embeddings.service';

@Module({
	imports: [PrismaModule],
	providers: [EmbeddingSettings, EmbeddingsService],
	exports: [EmbeddingsService],
})
export class EmbeddingsModule {}
