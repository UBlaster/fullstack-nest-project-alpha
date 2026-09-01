import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthenticatedRequest } from '../auth/authenticated-request';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { DocumentsService } from './documents.service';

@UseGuards(AuthGuard('jwt'))
@Controller()
export class DocumentsController {
	constructor(private readonly documentsService: DocumentsService) {}

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
