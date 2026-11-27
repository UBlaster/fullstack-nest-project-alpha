import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { DocumentsModule } from './documents/documents.module';
import { DocumentFilesModule } from './document-files/document-files.module';
import { DocumentPipelineModule } from './document-pipeline/document-pipeline.module';
import { SearchModule } from './search/search.module';
import { ExportsModule } from './exports/exports.module';
import { OutboxModule } from './outbox/outbox.module';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Controller('health')
class HealthController {
	@Get()
	health() {
		return {
			status: 'ok',
		};
	}
}

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
		}),
		PrismaModule,
		AuthModule,
		WorkspacesModule,
		ProjectsModule,
		DocumentsModule,
		DocumentFilesModule,
		DocumentPipelineModule,
		SearchModule,
		ExportsModule,
		OutboxModule,
		PaymentsModule,
	],
	controllers: [HealthController],
})
export class AppModule {}
