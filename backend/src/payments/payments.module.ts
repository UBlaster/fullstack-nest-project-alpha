import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentWebhooksController } from './controllers/payment-webhooks.controller';
import { PaymentsController } from './controllers/payments.controller';
import { WorkspacePaymentsController } from './controllers/workspace-payments.controller';
import { PaymentMaintenanceService } from './payment-maintenance.service';
import { PaymentRecoveryService } from './payment-recovery.service';
import { PaymentTransitionService } from './payment-transition.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentsService } from './payments.service';
import { PaymentWebhookRateGuard } from './webhook-rate.guard';
import {
	STRIPE_API_BASE,
	STRIPE_PRODUCTION_API,
	StripePaymentProvider,
} from './stripe-payment.provider';

@Module({
	imports: [PrismaModule, AccessModule],
	controllers: [PaymentsController, WorkspacePaymentsController, PaymentWebhooksController],
	providers: [
		PaymentsService,
		PaymentRecoveryService,
		PaymentTransitionService,
		PaymentWebhookService,
		PaymentMaintenanceService,
		StripePaymentProvider,
		PaymentWebhookRateGuard,
		{ provide: STRIPE_API_BASE, useValue: STRIPE_PRODUCTION_API },
	],
	exports: [
		PaymentsService,
		PaymentTransitionService,
		PaymentMaintenanceService,
		StripePaymentProvider,
	],
})
export class PaymentsModule {}
