import { Module, Controller, Get } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { AuthModule } from './auth';
import {
	ProjectsController,
	ProjectsService,
	DocumentsController,
	DocumentsService,
} from './resources';
@Controller('health')
class HealthController {
	@Get() health() {
		return { status: 'ok' };
	}
}
@Module({
	imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule],
	controllers: [HealthController, ProjectsController, DocumentsController],
	providers: [PrismaService, ProjectsService, DocumentsService],
})
export class AppModule {}
