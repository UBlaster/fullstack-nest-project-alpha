import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Sse } from '@nestjs/common';
import { EMPTY } from 'rxjs';
import { AuthenticatedRequest } from '../../auth/authenticated-request';
import { JwtAuth } from '../../auth/decorators/jwt-auth.decorator';
import { PaymentsService } from '../payments.service';

@JwtAuth()
@Controller('payments')
export class PaymentsController {
	constructor(private readonly paymentsService: PaymentsService) {}

	@Get(':id')
	get(@Req() req: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
		return this.paymentsService.get(req.user.sub, id);
	}

	@Sse(':id/events')
	async events(@Req() req: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
		const events = await this.paymentsService.events(req.user.sub, id);
		return req.res?.destroyed ? EMPTY : events;
	}

	@Post(':id/reconcile')
	@HttpCode(200)
	reconcile(@Req() req: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
		return this.paymentsService.reconcile(req.user.sub, id);
	}
}
