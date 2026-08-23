ALTER TABLE "User" RENAME COLUMN "passwordHash" TO "password";
UPDATE "User" SET "password" = 'password123';
