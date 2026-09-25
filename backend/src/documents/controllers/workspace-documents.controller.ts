import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { Response } from 'express';
import { AuthenticatedRequest } from '../../auth/authenticated-request';
import { JwtAuth } from '../../auth/decorators/jwt-auth.decorator';
import { DocumentsService } from '../documents.service';
import { DocumentsExportService } from '../documents-export.service';
import { SearchDocumentsQueryDto } from '../dto/search-documents-query.dto';

@JwtAuth()
@Controller('workspaces/:workspaceId/documents')
export class WorkspaceDocumentsController {
	constructor(
		private readonly documentsService: DocumentsService,
		private readonly documentsExport: DocumentsExportService,
	) {}

	@Get('export.csv')
	exportCsv(
		@Param('workspaceId') workspaceId: string,
		@Req() request: AuthenticatedRequest,
		@Res() response: Response,
	): Promise<void> {
		return this.documentsExport.export(request.user.sub, workspaceId, request, response);
	}

	@Get('search')
	search(
		@Param('workspaceId') workspaceId: string,
		@Query() dto: SearchDocumentsQueryDto,
		@Req() request: AuthenticatedRequest,
	) {
		return this.documentsService.search(request.user.sub, workspaceId, dto);
	}
}
