import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../../auth/authenticated-request';
import { JwtAuth } from '../../auth/decorators/jwt-auth.decorator';
import { DocumentsService } from '../documents.service';
import { SearchDocumentsQueryDto } from '../dto/search-documents-query.dto';

@JwtAuth()
@Controller('workspaces/:workspaceId/documents')
export class WorkspaceDocumentsController {
	constructor(private readonly documentsService: DocumentsService) {}

	@Get('search')
	search(
		@Param('workspaceId') workspaceId: string,
		@Query() dto: SearchDocumentsQueryDto,
		@Req() request: AuthenticatedRequest,
	) {
		return this.documentsService.search(request.user.sub, workspaceId, dto);
	}
}
