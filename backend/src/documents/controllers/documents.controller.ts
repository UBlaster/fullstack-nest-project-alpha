import { Body, Controller, Delete, Get, Param, Patch, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/authenticated-request';
import { JwtAuth } from '../../auth/decorators/jwt-auth.decorator';
import { UpdateDocumentDto } from '../dto/update-document.dto';
import { DocumentsService } from '../documents.service';

@JwtAuth()
@Controller('documents')
export class DocumentsController {
	constructor(private documentsService: DocumentsService) {}

	@Get(':documentId')
	get(@Param('documentId') documentId: string, @Req() request: AuthenticatedRequest) {
		return this.documentsService.get(request.user.sub, documentId);
	}

	@Patch(':documentId/archive')
	archive(@Param('documentId') documentId: string, @Req() request: AuthenticatedRequest) {
		return this.documentsService.archive(request.user.sub, documentId);
	}

	@Patch(':documentId')
	update(
		@Param('documentId') documentId: string,
		@Body() dto: UpdateDocumentDto,
		@Req() request: AuthenticatedRequest,
	) {
		return this.documentsService.update(request.user.sub, documentId, dto);
	}

	@Delete(':documentId')
	remove(@Param('documentId') documentId: string, @Req() request: AuthenticatedRequest) {
		return this.documentsService.remove(request.user.sub, documentId);
	}
}
