import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
	imports: [AccessModule],
	controllers: [DocumentsController],
	providers: [DocumentsService],
})
export class DocumentsModule {}
