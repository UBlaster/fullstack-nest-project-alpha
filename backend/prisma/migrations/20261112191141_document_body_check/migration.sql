BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE "Document"
  ADD CONSTRAINT "document_body_nn" CHECK ("body" IS NOT NULL) NOT VALID;

COMMIT;
