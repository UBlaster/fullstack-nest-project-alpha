import { Prisma } from '@prisma/client';

export const paymentResponseSelect = {
	id: true,
	workspaceId: true,
	purpose: true,
	provider: true,
	amountMinor: true,
	currency: true,
	status: true,
	confirmationUrl: true,
	needsReview: true,
	lastErrorCode: true,
	createdAt: true,
	updatedAt: true,
} satisfies Prisma.PaymentSelect;

export type PaymentResponseRow = Prisma.PaymentGetPayload<{
	select: typeof paymentResponseSelect;
}>;
