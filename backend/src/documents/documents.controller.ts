import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Patch,
	Post,
	Query,
	Req,
	Res,
	UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { AuthenticatedRequest } from '../auth/authenticated-request';
import { DocumentsExportService } from './documents-export.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { SearchDocumentsQueryDto } from './dto/search-documents-query.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { DocumentsService } from './documents.service';

@UseGuards(AuthGuard('jwt'))
@Controller()
export class DocumentsController {
	constructor(
		private readonly documentsService: DocumentsService,
		private readonly documentsExport: DocumentsExportService,
	) {}

	@Get('workspaces/:workspaceId/documents/export.csv')
	exportCsv(
		@Param('workspaceId') workspaceId: string,
		@Req() request: AuthenticatedRequest,
		@Res() response: Response,
	): Promise<void> {
		return this.documentsExport.export(request.user.sub, workspaceId, request, response);
	}

	@Get('workspaces/:workspaceId/documents/search')
	search(
		@Param('workspaceId') workspaceId: string,
		@Query() dto: SearchDocumentsQueryDto,
		@Req() request: AuthenticatedRequest,
	) {
		return this.documentsService.search(request.user.sub, workspaceId, dto);
	}

	@Get('projects/:projectId/documents')
	list(@Param('projectId') projectId: string, @Req() request: AuthenticatedRequest) {
		return this.documentsService.list(request.user.sub, projectId);
	}

	@Post('projects/:projectId/documents')
	create(
		@Param('projectId') projectId: string,
		@Body() dto: CreateDocumentDto,
		@Req() request: AuthenticatedRequest,
	) {
		return this.documentsService.create(request.user.sub, projectId, dto);
	}

	@Get('documents/:documentId')
	get(@Param('documentId') documentId: string, @Req() request: AuthenticatedRequest) {
		return this.documentsService.get(request.user.sub, documentId);
	}

	@Patch('documents/:documentId/archive')
	archive(@Param('documentId') documentId: string, @Req() request: AuthenticatedRequest) {
		return this.documentsService.archive(request.user.sub, documentId);
	}

	@Patch('documents/:documentId')
	update(
		@Param('documentId') documentId: string,
		@Body() dto: UpdateDocumentDto,
		@Req() request: AuthenticatedRequest,
	) {
		return this.documentsService.update(request.user.sub, documentId, dto);
	}

	@Delete('documents/:documentId')
	remove(@Param('documentId') documentId: string, @Req() request: AuthenticatedRequest) {
		return this.documentsService.remove(request.user.sub, documentId);
	}
}
