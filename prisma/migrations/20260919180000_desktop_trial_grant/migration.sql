-- KoopPlus otomatik 7 günlük demo hakkı.
-- Additive only: yeni enum + yeni tablo. Mevcut tablolara DROP/ALTER yok.

CREATE TYPE "DesktopTrialStatus" AS ENUM ('ACTIVE', 'EXPIRED');

CREATE TABLE "DesktopTrialGrant" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "deviceHash" TEXT NOT NULL,
    "deviceName" TEXT,
    "platform" TEXT,
    "appVersion" TEXT,
    "licenseId" TEXT,
    "status" "DesktopTrialStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastValidatedAt" TIMESTAMP(3),

    CONSTRAINT "DesktopTrialGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DesktopTrialGrant_programId_deviceHash_key" ON "DesktopTrialGrant"("programId", "deviceHash");

CREATE INDEX "DesktopTrialGrant_programId_idx" ON "DesktopTrialGrant"("programId");

CREATE INDEX "DesktopTrialGrant_expiresAt_idx" ON "DesktopTrialGrant"("expiresAt");

CREATE INDEX "DesktopTrialGrant_licenseId_idx" ON "DesktopTrialGrant"("licenseId");

ALTER TABLE "DesktopTrialGrant" ADD CONSTRAINT "DesktopTrialGrant_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DesktopTrialGrant" ADD CONSTRAINT "DesktopTrialGrant_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE SET NULL ON UPDATE CASCADE;
