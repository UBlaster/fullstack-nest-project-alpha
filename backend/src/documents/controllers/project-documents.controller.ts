import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/authenticated-request';
import { JwtAuth } from '../../auth/decorators/jwt-auth.decorator';
import { DocumentsService } from '../documents.service';

@JwtAuth()
@Controller('projects/:projectId/documents')
export class ProjectDocumentsController {
	constructor(private readonly documentsService: DocumentsService) {}

	@Get()
	list(@Param('projectId') projectId: string, @Req() request: AuthenticatedRequest) {
		return this.documentsService.list(projectId, request.user.sub);
	}

	@Post()
	create(
		@Param('projectId') projectId: string,
		@Body() data: any,
		@Req() request: AuthenticatedRequest,
	) {
		return this.documentsService.create(projectId, request.user.sub, data);
	}
}
