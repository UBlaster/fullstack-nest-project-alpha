BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE "Document" ADD COLUMN "body" TEXT;

COMMIT;
