BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- Existing operations retain their original provider and are never retried at Stripe.
ALTER TABLE "Payment" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'yookassa';
ALTER TABLE "Payment" ALTER COLUMN "provider" SET DEFAULT 'stripe';
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_provider_check"
  CHECK ("provider" IN ('stripe', 'yookassa'));

COMMIT;
