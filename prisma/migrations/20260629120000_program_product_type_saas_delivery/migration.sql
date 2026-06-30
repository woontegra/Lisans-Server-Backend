-- Program product type (SaaS / Desktop)
CREATE TYPE "ProgramProductType" AS ENUM ('DESKTOP', 'SAAS');
CREATE TYPE "ProvisionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

ALTER TABLE "Program" ADD COLUMN "productType" "ProgramProductType" NOT NULL DEFAULT 'DESKTOP';
ALTER TABLE "Program" ADD COLUMN "targetService" TEXT;
ALTER TABLE "Program" ADD COLUMN "saasProductCode" TEXT;

CREATE TABLE "SaasDelivery" (
    "id" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "customerId" TEXT,
    "programId" TEXT NOT NULL,
    "targetService" TEXT NOT NULL,
    "provisionStatus" "ProvisionStatus" NOT NULL DEFAULT 'PENDING',
    "provisionError" TEXT,
    "provisionedAt" TIMESTAMP(3),
    "lastProvisionAttemptAt" TIMESTAMP(3),
    "externalTenantId" TEXT,
    "externalTenantSlug" TEXT,
    "loginUrl" TEXT,
    "mailSent" BOOLEAN NOT NULL DEFAULT false,
    "rawResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaasDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SaasDelivery_externalOrderId_key" ON "SaasDelivery"("externalOrderId");
CREATE INDEX "SaasDelivery_programId_idx" ON "SaasDelivery"("programId");
CREATE INDEX "SaasDelivery_provisionStatus_idx" ON "SaasDelivery"("provisionStatus");
CREATE INDEX "SaasDelivery_customerId_idx" ON "SaasDelivery"("customerId");

ALTER TABLE "SaasDelivery" ADD CONSTRAINT "SaasDelivery_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SaasDelivery" ADD CONSTRAINT "SaasDelivery_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
