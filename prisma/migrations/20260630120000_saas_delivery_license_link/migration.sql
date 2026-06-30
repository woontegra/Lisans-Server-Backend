-- Link SaaS deliveries to central License records (WTG keys)
ALTER TABLE "SaasDelivery" ADD COLUMN "licenseId" TEXT;

ALTER TABLE "SaasDelivery" ADD CONSTRAINT "SaasDelivery_licenseId_fkey"
  FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "SaasDelivery_licenseId_idx" ON "SaasDelivery"("licenseId");
