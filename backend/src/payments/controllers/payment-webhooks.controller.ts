import {
	Controller,
	Headers,
	HttpCode,
	Post,
	RawBodyRequest,
	Req,
	UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { PaymentWebhookService } from '../payment-webhook.service';
import { PaymentWebhookRateGuard } from '../webhook-rate.guard';

@Controller('payments/webhooks')
export class PaymentWebhooksController {
	constructor(private readonly paymentWebhookService: PaymentWebhookService) {}

	@Post('stripe')
	@HttpCode(200)
	@UseGuards(PaymentWebhookRateGuard)
	async webhook(
		@Req() req: RawBodyRequest<Request>,
		@Headers('stripe-signature') signature: string | string[] | undefined,
	) {
		await this.paymentWebhookService.handleStripeWebhook(req.rawBody, signature);
		return { received: true };
	}
}
