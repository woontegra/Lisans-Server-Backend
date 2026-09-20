-- KoopPlus trial abuse: email + phone uniqueness.
-- Additive only. Existing DesktopTrialGrant rows keep NULL contact fields.
-- PostgreSQL UNIQUE allows multiple NULLs, so legacy deviceHash-only grants remain valid.

ALTER TABLE "DesktopTrialGrant" ADD COLUMN "emailNormalized" TEXT;
ALTER TABLE "DesktopTrialGrant" ADD COLUMN "phoneNormalized" TEXT;

CREATE UNIQUE INDEX "DesktopTrialGrant_programId_emailNormalized_key" ON "DesktopTrialGrant"("programId", "emailNormalized");

CREATE UNIQUE INDEX "DesktopTrialGrant_programId_phoneNormalized_key" ON "DesktopTrialGrant"("programId", "phoneNormalized");
