-- Bilirkişi Desktop platform entitlement + trial scope.
-- Existing products keep platform NULL and platformScope ''.
-- deviceBound defaults true so current grants stay bound to their device.

ALTER TABLE "License" ADD COLUMN "platform" TEXT;

ALTER TABLE "DesktopTrialGrant" ADD COLUMN "platformScope" TEXT NOT NULL DEFAULT '';
ALTER TABLE "DesktopTrialGrant" ADD COLUMN "deviceBound" BOOLEAN NOT NULL DEFAULT true;

DROP INDEX "DesktopTrialGrant_programId_deviceHash_key";
DROP INDEX "DesktopTrialGrant_programId_emailNormalized_key";
DROP INDEX "DesktopTrialGrant_programId_phoneNormalized_key";

CREATE UNIQUE INDEX "DesktopTrialGrant_programId_platformScope_deviceHash_key"
  ON "DesktopTrialGrant"("programId", "platformScope", "deviceHash");
CREATE UNIQUE INDEX "DesktopTrialGrant_programId_platformScope_emailNormalized_key"
  ON "DesktopTrialGrant"("programId", "platformScope", "emailNormalized");
CREATE UNIQUE INDEX "DesktopTrialGrant_programId_platformScope_phoneNormalized_key"
  ON "DesktopTrialGrant"("programId", "platformScope", "phoneNormalized");
