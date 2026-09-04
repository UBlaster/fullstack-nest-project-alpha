import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CacheModule } from '../cache/cache.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
	imports: [AccessModule, CacheModule],
	controllers: [DocumentsController],
	providers: [DocumentsService],
})
export class DocumentsModule {}
