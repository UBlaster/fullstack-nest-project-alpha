CREATE TYPE "DocumentFileStatus" AS ENUM ('PENDING', 'READY', 'DELETING', 'FAILED');

CREATE TABLE "DocumentFile" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "etag" TEXT,
    "status" "DocumentFileStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentFile_objectKey_key" ON "DocumentFile"("objectKey");
CREATE INDEX "DocumentFile_documentId_idx" ON "DocumentFile"("documentId");
CREATE INDEX "DocumentFile_status_createdAt_idx" ON "DocumentFile"("status", "createdAt");

ALTER TABLE "DocumentFile"
ADD CONSTRAINT "DocumentFile_documentId_fkey"
FOREIGN KEY ("documentId") REFERENCES "Document"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
