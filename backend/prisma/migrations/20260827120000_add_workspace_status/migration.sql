CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

ALTER TABLE "Workspace" ADD COLUMN "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE';
