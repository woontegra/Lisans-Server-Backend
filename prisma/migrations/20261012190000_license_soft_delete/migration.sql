-- AlterEnum
ALTER TYPE "LicenseEventType" ADD VALUE 'LICENSE_DELETED';

-- AlterTable
ALTER TABLE "License" ADD COLUMN "deletedAt" TIMESTAMP(3),
ADD COLUMN "deletedByEmail" TEXT;

-- CreateIndex
CREATE INDEX "License_deletedAt_idx" ON "License"("deletedAt");
