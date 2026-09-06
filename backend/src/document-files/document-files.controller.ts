import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	Post,
	Req,
	UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthenticatedRequest } from '../auth/authenticated-request';
import { DocumentFilesService } from './document-files.service';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';

@UseGuards(AuthGuard('jwt'))
@Controller('documents/:documentId/files')
export class DocumentFilesController {
	constructor(private readonly documentFiles: DocumentFilesService) {}

	@Get()
	list(@Param('documentId') documentId: string, @Req() request: AuthenticatedRequest) {
		return this.documentFiles.list(request.user.sub, documentId);
	}

	@Get('capabilities')
	capabilities(@Param('documentId') documentId: string, @Req() request: AuthenticatedRequest) {
		return this.documentFiles.capabilities(request.user.sub, documentId);
	}

	@Post('upload-url')
	createUploadUrl(
		@Param('documentId') documentId: string,
		@Body() dto: CreateUploadUrlDto,
		@Req() request: AuthenticatedRequest,
	) {
		return this.documentFiles.createUploadUrl(request.user.sub, documentId, dto);
	}

	@Post(':fileId/complete')
	@HttpCode(200)
	complete(
		@Param('documentId') documentId: string,
		@Param('fileId') fileId: string,
		@Req() request: AuthenticatedRequest,
	) {
		return this.documentFiles.complete(request.user.sub, documentId, fileId);
	}

	@Get(':fileId/download-url')
	createDownloadUrl(
		@Param('documentId') documentId: string,
		@Param('fileId') fileId: string,
		@Req() request: AuthenticatedRequest,
	) {
		return this.documentFiles.createDownloadUrl(request.user.sub, documentId, fileId);
	}

	@Delete(':fileId')
	@HttpCode(204)
	async remove(
		@Param('documentId') documentId: string,
		@Param('fileId') fileId: string,
		@Req() request: AuthenticatedRequest,
	): Promise<void> {
		await this.documentFiles.remove(request.user.sub, documentId, fileId);
	}
}
