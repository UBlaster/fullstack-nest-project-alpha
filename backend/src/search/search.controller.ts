import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../auth/authenticated-request';
import { JwtAuth } from '../auth/decorators/jwt-auth.decorator';
import { HybridSearchQuery } from './search.controller.dto';
import { HybridSearchService } from './search.service';

@JwtAuth()
@Controller('workspaces/:workspaceId/search')
export class SearchController {
	constructor(private readonly service: HybridSearchService) {}

	@Get()
	search(
		@Param('workspaceId') workspaceId: string,
		@Query() query: HybridSearchQuery,
		@Req() request: AuthenticatedRequest,
	) {
		return this.service.search(request.user.sub, workspaceId, query);
	}
}
