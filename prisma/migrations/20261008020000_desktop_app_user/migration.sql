-- Desktop kullanıcı hesapları. Mevcut Customer, License ve DesktopTrialGrant satırlarını taşımaz.
CREATE TABLE "DesktopAppUser" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "securityQuestion" TEXT NOT NULL,
    "securityAnswerHash" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "licenseId" TEXT,
    "trialGrantId" TEXT,
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DesktopAppUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DesktopAuthCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "purpose" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "licenseId" TEXT,
    "trialGrantId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesktopAuthCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DesktopAppUser_username_key" ON "DesktopAppUser"("username");
CREATE UNIQUE INDEX "DesktopAppUser_licenseId_key" ON "DesktopAppUser"("licenseId");
CREATE UNIQUE INDEX "DesktopAppUser_trialGrantId_key" ON "DesktopAppUser"("trialGrantId");
CREATE INDEX "DesktopAppUser_emailNormalized_idx" ON "DesktopAppUser"("emailNormalized");
CREATE INDEX "DesktopAuthCode_licenseId_purpose_idx" ON "DesktopAuthCode"("licenseId", "purpose");
CREATE INDEX "DesktopAuthCode_trialGrantId_purpose_idx" ON "DesktopAuthCode"("trialGrantId", "purpose");
CREATE INDEX "DesktopAuthCode_userId_purpose_idx" ON "DesktopAuthCode"("userId", "purpose");

ALTER TABLE "DesktopAppUser" ADD CONSTRAINT "DesktopAppUser_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DesktopAppUser" ADD CONSTRAINT "DesktopAppUser_trialGrantId_fkey" FOREIGN KEY ("trialGrantId") REFERENCES "DesktopTrialGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DesktopAuthCode" ADD CONSTRAINT "DesktopAuthCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "DesktopAppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DesktopAppUser" ADD CONSTRAINT "DesktopAppUser_one_subject_check" CHECK (
    (CASE WHEN "licenseId" IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN "trialGrantId" IS NULL THEN 0 ELSE 1 END) = 1
);
