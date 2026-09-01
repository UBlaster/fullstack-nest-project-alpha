CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

ALTER TABLE "Workspace"
ADD COLUMN "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE';

ALTER TYPE "WorkspaceRole" RENAME TO "WorkspaceRole_old";

CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'MEMBER', 'VIEWER');

ALTER TABLE "WorkspaceMember"
ALTER COLUMN "role" TYPE "WorkspaceRole"
USING (
  CASE
    WHEN "role"::text = 'ADMIN' THEN 'MEMBER'
    ELSE "role"::text
  END
)::"WorkspaceRole";

DROP TYPE "WorkspaceRole_old";
