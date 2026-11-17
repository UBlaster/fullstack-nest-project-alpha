import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Headers,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Post,
	Query,
	Req,
	Res,
	UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Type } from 'class-transformer';
import {
	Equals,
	IsIn,
	IsInt,
	IsObject,
	IsString,
	isUUID,
	Matches,
	Max,
	Min,
	ValidateNested,
} from 'class-validator';
import { Response } from 'express';
import { AuthenticatedRequest } from '../auth/authenticated-request';
import { PaymentsService } from './payments.service';
import { PaymentWebhookRateGuard } from './webhook-rate.guard';

export class CreatePaymentDto {
	@Equals('WORKSPACE_DEMO') declare purpose: 'WORKSPACE_DEMO';
}

export class PaymentHistoryQuery {
	@Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}

class WebhookObject {
	@IsString() @Matches(/^[a-zA-Z0-9_-]{1,64}$/) declare id: string;
}

export class YooKassaWebhookDto {
	@Equals('notification') declare type: 'notification';
	@IsIn(['payment.succeeded', 'payment.canceled']) declare event: string;
	@IsObject() @ValidateNested() @Type(() => WebhookObject) declare object: WebhookObject;
}

@Controller('workspaces/:workspaceId/payments')
@UseGuards(AuthGuard('jwt'))
export class WorkspacePaymentsController {
	constructor(private readonly payments: PaymentsService) {}

	@Get('capabilities')
	capabilities(@Req() req: AuthenticatedRequest, @Param('workspaceId') workspaceId: string) {
		return this.payments.capabilities(req.user.sub, workspaceId);
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
		const result = await this.payments.create(req.user.sub, workspaceId, body.purpose, key);
		response.status(result.statusCode);
		return result.payment;
	}

	@Get()
	history(
		@Req() req: AuthenticatedRequest,
		@Param('workspaceId') workspaceId: string,
		@Query() query: PaymentHistoryQuery,
	) {
		return this.payments.history(req.user.sub, workspaceId, query.limit);
	}
}

@Controller('payments')
export class PaymentsController {
	constructor(private readonly payments: PaymentsService) {}

	@Post('webhooks/yookassa')
	@HttpCode(200)
	@UseGuards(PaymentWebhookRateGuard)
	async webhook(@Body() body: YooKassaWebhookDto) {
		await this.payments.webhook(body.event, body.object.id);
		return { received: true };
	}

	@Get(':id')
	@UseGuards(AuthGuard('jwt'))
	get(@Req() req: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
		return this.payments.get(req.user.sub, id);
	}

	@Post(':id/reconcile')
	@HttpCode(200)
	@UseGuards(AuthGuard('jwt'))
	reconcile(@Req() req: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
		return this.payments.reconcile(req.user.sub, id);
	}
}
