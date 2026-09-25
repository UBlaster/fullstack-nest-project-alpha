import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { WorkspacesController } from './controllers/workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
	imports: [AccessModule],
	controllers: [WorkspacesController],
	providers: [WorkspacesService],
})
export class WorkspacesModule {}
