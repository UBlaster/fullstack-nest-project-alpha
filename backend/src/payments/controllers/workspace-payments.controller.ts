import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Headers,
	Param,
	Post,
	Query,
	Req,
	Res,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Response } from 'express';
import { AuthenticatedRequest } from '../../auth/authenticated-request';
import { JwtAuth } from '../../auth/decorators/jwt-auth.decorator';
import { CreatePaymentDto } from '../dto/create-payment.dto';
import { PaymentHistoryQueryDto } from '../dto/payment-history-query.dto';
import { PaymentsService } from '../payments.service';

@JwtAuth()
@Controller('workspaces/:workspaceId/payments')
export class WorkspacePaymentsController {
	constructor(private readonly paymentsService: PaymentsService) {}

	@Get('capabilities')
	capabilities(@Req() req: AuthenticatedRequest, @Param('workspaceId') workspaceId: string) {
		return this.paymentsService.capabilities(req.user.sub, workspaceId);
	}

	@Post()
	async create(
		@Req() req: AuthenticatedRequest,
		@Param('workspaceId') workspaceId: string,
		@Body() body: CreatePaymentDto,
		@Headers('idempotency-key') key: string,
		@Res({ passthrough: true }) response: Response,
	) {
		if (typeof key !== 'string' || !isUUID(key))
			throw new BadRequestException('Idempotency-Key must be a UUID');
		const result = await this.paymentsService.create(req.user.sub, workspaceId, body.purpose, key);
		response.status(result.statusCode);
		return result.payment;
	}

	@Get()
	history(
		@Req() req: AuthenticatedRequest,
		@Param('workspaceId') workspaceId: string,
		@Query() query: PaymentHistoryQueryDto,
	) {
		return this.paymentsService.history(req.user.sub, workspaceId, query.limit);
	}
}
