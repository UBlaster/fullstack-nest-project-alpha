import { Body, Controller, Delete, Get, Param, Patch, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/authenticated-request';
import { JwtAuth } from '../../auth/decorators/jwt-auth.decorator';
import { DocumentsService } from '../documents.service';

@JwtAuth()
@Controller('documents')
export class DocumentsController {
	constructor(private documentsService: DocumentsService) {}

	@Get(':id')
	get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
		return this.documentsService.get(id, request.user.sub);
	}

	@Patch(':id')
	update(@Param('id') id: string, @Body() data: any, @Req() request: AuthenticatedRequest) {
		return this.documentsService.update(id, request.user.sub, data);
	}

	@Delete(':id')
	remove(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
		return this.documentsService.remove(id, request.user.sub);
	}
}
