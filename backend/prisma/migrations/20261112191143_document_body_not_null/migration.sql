BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE "Document" ALTER COLUMN "body" SET NOT NULL;

COMMIT;
