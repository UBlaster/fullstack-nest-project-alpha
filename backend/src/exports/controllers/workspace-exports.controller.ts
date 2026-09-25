import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/authenticated-request';
import { JwtAuth } from '../../auth/decorators/jwt-auth.decorator';
import { CreateExportDto } from '../dto/create-export.dto';
import { ExportsService } from '../exports.service';

@JwtAuth()
@Controller('workspaces/:workspaceId/exports')
export class WorkspaceExportsController {
	constructor(private readonly exportsService: ExportsService) {}

	@Post()
	@HttpCode(202)
	create(
		@Param('workspaceId') workspaceId: string,
		@Req() request: AuthenticatedRequest,
		@Body() _body: CreateExportDto,
	) {
		return this.exportsService.create(request.user.sub, workspaceId);
	}
}
