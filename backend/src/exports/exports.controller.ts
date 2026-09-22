import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	Post,
	Req,
	UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthenticatedRequest } from '../auth/authenticated-request';
import { CreateExportDto } from './dto/create-export.dto';
import { ExportsService } from './exports.service';

@UseGuards(AuthGuard('jwt'))
@Controller()
export class ExportsController {
	constructor(private readonly exportsService: ExportsService) {}

	@Post('workspaces/:workspaceId/exports')
	@HttpCode(202)
	create(
		@Param('workspaceId') workspaceId: string,
		@Req() request: AuthenticatedRequest,
		@Body() _body: CreateExportDto,
	) {
		return this.exportsService.create(request.user.sub, workspaceId);
	}

	@Get('exports/:exportId')
	get(@Param('exportId') exportId: string, @Req() request: AuthenticatedRequest) {
		return this.exportsService.get(request.user.sub, exportId);
	}

	@Delete('exports/:exportId')
	@HttpCode(202)
	cancel(@Param('exportId') exportId: string, @Req() request: AuthenticatedRequest) {
		return this.exportsService.cancel(request.user.sub, exportId);
	}
}
