CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "DocumentVersionStatus" AS ENUM ('UPLOADED', 'EXTRACTING', 'NORMALIZING', 'CHUNKING', 'EMBEDDING', 'INDEXED', 'FAILED');

-- CreateEnum
CREATE TYPE "PipelineStage" AS ENUM ('EXTRACT', 'NORMALIZE', 'CHUNK', 'EMBED', 'INDEX', 'ACTIVATE');

-- CreateEnum
CREATE TYPE "PipelineRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- AlterEnum
ALTER TYPE "OutboxEventType" ADD VALUE 'PIPELINE_STAGE';

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "currentVersionId" TEXT;

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "pipelineVersion" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "DocumentVersionStatus" NOT NULL DEFAULT 'UPLOADED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineStageRun" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "stage" "PipelineStage" NOT NULL,
    "inputHash" TEXT NOT NULL,
    "status" "PipelineRunStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "dispatch" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "claimToken" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineStageRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTextPart" (
    "versionId" TEXT NOT NULL,
    "stage" "PipelineStage" NOT NULL,
    "partIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "DocumentTextPart_pkey" PRIMARY KEY ("versionId","stage","partIndex")
);

-- CreateTable
CREATE TABLE "DocumentChunk" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "textHash" TEXT NOT NULL,

    CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentEmbedding" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "embeddingVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dimension" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "embedding" vector(1024) NOT NULL,

    CONSTRAINT "DocumentEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmbeddingReadConfig" (
    "id" TEXT NOT NULL,
    "embeddingVersion" TEXT NOT NULL,
    "writeVersions" TEXT[] NOT NULL,

    CONSTRAINT "EmbeddingReadConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentVersion_sourceFileId_idx" ON "DocumentVersion"("sourceFileId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_documentId_version_key" ON "DocumentVersion"("documentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_documentId_contentHash_key" ON "DocumentVersion"("documentId", "contentHash");

-- CreateIndex
CREATE INDEX "PipelineStageRun_status_heartbeatAt_idx" ON "PipelineStageRun"("status", "heartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineStageRun_versionId_stage_inputHash_key" ON "PipelineStageRun"("versionId", "stage", "inputHash");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentChunk_versionId_chunkIndex_key" ON "DocumentChunk"("versionId", "chunkIndex");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentEmbedding_chunkId_embeddingVersion_key" ON "DocumentEmbedding"("chunkId", "embeddingVersion");

-- CreateIndex
CREATE UNIQUE INDEX "Document_currentVersionId_key" ON "Document"("currentVersionId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "DocumentFile"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineStageRun" ADD CONSTRAINT "PipelineStageRun_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTextPart" ADD CONSTRAINT "DocumentTextPart_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentEmbedding" ADD CONSTRAINT "DocumentEmbedding_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "DocumentChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE INDEX "DocumentEmbedding_embedding_hnsw_idx" ON "DocumentEmbedding" USING hnsw ("embedding" vector_cosine_ops);
