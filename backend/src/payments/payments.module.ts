import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentMaintenanceService } from './payment-maintenance.service';
import { PaymentTransitionService } from './payment-transition.service';
import { PaymentsController, WorkspacePaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentWebhookRateGuard } from './webhook-rate.guard';
import {
	YOOKASSA_API_BASE,
	YOOKASSA_PRODUCTION_API,
	YooKassaPaymentProvider,
} from './yookassa-payment.provider';

@Module({
	imports: [PrismaModule, AccessModule],
	controllers: [PaymentsController, WorkspacePaymentsController],
	providers: [
		PaymentsService,
		PaymentTransitionService,
		PaymentMaintenanceService,
		YooKassaPaymentProvider,
		PaymentWebhookRateGuard,
		{ provide: YOOKASSA_API_BASE, useValue: YOOKASSA_PRODUCTION_API },
	],
	exports: [
		PaymentsService,
		PaymentTransitionService,
		PaymentMaintenanceService,
		YooKassaPaymentProvider,
	],
})
export class PaymentsModule {}
