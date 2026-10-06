-- Bilirkişi Desktop trial → first purchase. Not a renewal session.
CREATE TABLE "DesktopPurchaseSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "appCode" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "deviceHash" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'FIRST_PURCHASE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "orderNo" TEXT,
    "paidLicenseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesktopPurchaseSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DesktopPurchaseSession_tokenHash_key" ON "DesktopPurchaseSession"("tokenHash");
CREATE INDEX "DesktopPurchaseSession_grantId_idx" ON "DesktopPurchaseSession"("grantId");
CREATE INDEX "DesktopPurchaseSession_deviceHash_appCode_platform_idx" ON "DesktopPurchaseSession"("deviceHash", "appCode", "platform");
CREATE INDEX "DesktopPurchaseSession_orderNo_idx" ON "DesktopPurchaseSession"("orderNo");

ALTER TABLE "DesktopPurchaseSession" ADD CONSTRAINT "DesktopPurchaseSession_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "DesktopTrialGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
