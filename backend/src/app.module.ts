import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { DocumentsModule } from './documents/documents.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';

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
		ProjectsModule,
		DocumentsModule,
	],
	controllers: [HealthController],
})
export class AppModule {}
