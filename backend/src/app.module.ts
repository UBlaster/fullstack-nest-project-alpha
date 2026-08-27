import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth';
import { PrismaService } from './prisma.service';
import {
	DocumentsController,
	DocumentsService,
	ProjectsController,
	ProjectsService,
} from './resources';

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
		AuthModule,
	],
	controllers: [HealthController, ProjectsController, DocumentsController],
	providers: [PrismaService, ProjectsService, DocumentsService],
})
export class AppModule {}
