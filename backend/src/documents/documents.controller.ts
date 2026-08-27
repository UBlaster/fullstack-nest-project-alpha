import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CreateDocumentDto, UpdateDocumentDto } from './dto/document.dto';
import { DocumentsService } from './documents.service';

@Controller()
export class DocumentsController {
	constructor(private documentsService: DocumentsService) {}

	@UseGuards(AuthGuard('jwt'))
	@Get('projects/:projectId/documents')
	list(@Param('projectId') projectId: string, @Req() request: any) {
		return this.documentsService.list(projectId, request.user.sub);
	}

	@UseGuards(AuthGuard('jwt'))
	@Post('projects/:projectId/documents')
	create(
		@Param('projectId') projectId: string,
		@Body() dto: CreateDocumentDto,
		@Req() request: any,
	) {
		return this.documentsService.create(projectId, request.user.sub, dto);
	}

	@UseGuards(AuthGuard('jwt'))
	@Get('documents/:documentId')
	get(@Param('documentId') documentId: string, @Req() request: any) {
		return this.documentsService.get(documentId, request.user.sub);
	}

	@UseGuards(AuthGuard('jwt'))
	@Patch('documents/:documentId/archive')
	archive(@Param('documentId') documentId: string, @Req() request: any) {
		return this.documentsService.archive(documentId, request.user.sub);
	}

	@UseGuards(AuthGuard('jwt'))
	@Patch('documents/:documentId')
	update(
		@Param('documentId') documentId: string,
		@Body() dto: UpdateDocumentDto,
		@Req() request: any,
	) {
		return this.documentsService.update(documentId, request.user.sub, dto);
	}

	@UseGuards(AuthGuard('jwt'))
	@Delete('documents/:documentId')
	remove(@Param('documentId') documentId: string, @Req() request: any) {
		return this.documentsService.remove(documentId, request.user.sub);
	}
}
