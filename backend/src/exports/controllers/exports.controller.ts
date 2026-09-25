import { Controller, Delete, Get, HttpCode, Param, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/authenticated-request';
import { JwtAuth } from '../../auth/decorators/jwt-auth.decorator';
import { ExportsService } from '../exports.service';

@JwtAuth()
@Controller('exports')
export class ExportsController {
	constructor(private readonly exportsService: ExportsService) {}

	@Get(':exportId')
	get(@Param('exportId') exportId: string, @Req() request: AuthenticatedRequest) {
		return this.exportsService.get(request.user.sub, exportId);
	}

	@Delete(':exportId')
	@HttpCode(202)
	cancel(@Param('exportId') exportId: string, @Req() request: AuthenticatedRequest) {
		return this.exportsService.cancel(request.user.sub, exportId);
	}
}
