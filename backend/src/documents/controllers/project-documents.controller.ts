import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/authenticated-request';
import { JwtAuth } from '../../auth/decorators/jwt-auth.decorator';
import { CreateDocumentDto } from '../dto/create-document.dto';
import { DocumentsService } from '../documents.service';

@JwtAuth()
@Controller('projects/:projectId/documents')
export class ProjectDocumentsController {
	constructor(private readonly documentsService: DocumentsService) {}

	@Get()
	list(@Param('projectId') projectId: string, @Req() request: AuthenticatedRequest) {
		return this.documentsService.list(request.user.sub, projectId);
	}

	@Post()
	create(
		@Param('projectId') projectId: string,
		@Body() dto: CreateDocumentDto,
		@Req() request: AuthenticatedRequest,
	) {
		return this.documentsService.create(request.user.sub, projectId, dto);
	}
}
