import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
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
	@Get('documents/:id')
	get(@Param('id') id: string, @Req() request: any) {
		return this.documentsService.get(id, request.user.sub);
	}

	@UseGuards(AuthGuard('jwt'))
	@Post('projects/:projectId/documents')
	create(@Param('projectId') projectId: string, @Body() data: any, @Req() request: any) {
		return this.documentsService.create(projectId, request.user.sub, data);
	}

	@UseGuards(AuthGuard('jwt'))
	@Patch('documents/:id')
	update(@Param('id') id: string, @Body() data: any, @Req() request: any) {
		return this.documentsService.update(id, request.user.sub, data);
	}

	@UseGuards(AuthGuard('jwt'))
	@Delete('documents/:id')
	remove(@Param('id') id: string, @Req() request: any) {
		return this.documentsService.remove(id, request.user.sub);
	}
}
