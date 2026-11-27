import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { AuthenticatedRequest } from '../auth/authenticated-request';
import { JwtAuth } from '../auth/decorators/jwt-auth.decorator';
import { DocumentVersionsService } from './document-versions.service';

class CreateVersionDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(200)
	declare sourceFileId: string;
}

@Controller()
@JwtAuth()
export class DocumentVersionsController {
	constructor(private readonly versions: DocumentVersionsService) {}
	@Post('documents/:id/versions')
	@HttpCode(202)
	create(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: CreateVersionDto) {
		return this.versions.create(req.user.sub, id, dto.sourceFileId);
	}
	@Get('documents/:id/versions')
	list(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
		return this.versions.list(req.user.sub, id);
	}
	@Get('document-versions/:id')
	get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
		return this.versions.get(req.user.sub, id);
	}
	@Post('document-versions/:id/retry')
	@HttpCode(202)
	retry(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
		return this.versions.retry(req.user.sub, id);
	}
}
