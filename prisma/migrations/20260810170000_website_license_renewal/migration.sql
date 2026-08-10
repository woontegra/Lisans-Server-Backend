-- Website masaüstü lisans yenileme idempotency kaydı
CREATE TABLE "WebsiteLicenseRenewal" (
    "id" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "renewalDays" INTEGER NOT NULL,
    "previousExpiresAt" TIMESTAMP(3) NOT NULL,
    "newExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebsiteLicenseRenewal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebsiteLicenseRenewal_externalOrderId_key" ON "WebsiteLicenseRenewal"("externalOrderId");

CREATE INDEX "WebsiteLicenseRenewal_licenseId_idx" ON "WebsiteLicenseRenewal"("licenseId");

ALTER TABLE "WebsiteLicenseRenewal" ADD CONSTRAINT "WebsiteLicenseRenewal_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;
