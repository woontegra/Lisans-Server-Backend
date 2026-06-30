import {
  LicenseSource,
  ProgramProductType,
  ProvisionStatus,
  type Customer,
  type License,
  type Program,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  getSaasProviderConfig,
  SAAS_PRODUCT_CODE_MISSING,
  SAAS_PROVIDER_NOT_CONFIGURED,
  SAAS_PROVISIONING_NOT_IMPLEMENTED,
  SAAS_TARGET_SERVICE_MISSING,
} from '../config/saasProviders';
import { createLicense } from './licenseService';
import { provisionMuvekkilKasaTenant } from './muvekkilKasaProvisioner';

export type SaasOrderInput = {
  customerId: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  orderNo: string;
  licenseDays?: number;
  maxDevices?: number;
  ipAddress?: string;
};

export type SaasOrderResult =
  | {
      ok: true;
      alreadyExists: boolean;
      deliveryType: 'SAAS';
      orderNo: string;
      programName: string;
      licenseKey: string;
      provisionStatus: ProvisionStatus;
      externalTenantId?: string | null;
      externalTenantSlug?: string | null;
      loginUrl?: string | null;
      mailSent: boolean;
    }
  | {
      ok: false;
      deliveryType: 'SAAS';
      orderNo: string;
      programName: string;
      licenseKey?: string;
      error: string;
      provisionStatus: ProvisionStatus;
    };

const MUVEKKIL_KASA_TARGET = 'MUVEKKIL_KASA';

export function isSaasProgram(program: Program): boolean {
  return program.productType === ProgramProductType.SAAS;
}

export function isDesktopProgram(program: Program): boolean {
  return program.productType === ProgramProductType.DESKTOP;
}

function websiteOrderNote(orderNo: string): string {
  return `Website sipariş no: ${orderNo}`;
}

async function ensureWebsiteSaasLicense(
  program: Program,
  customer: Customer,
  input: SaasOrderInput
): Promise<{ license: License; created: boolean }> {
  const noteMarker = websiteOrderNote(input.orderNo);
  const existing = await prisma.license.findFirst({
    where: {
      notes: noteMarker,
      source: LicenseSource.WEBSITE_ORDER,
      programId: program.id,
      customerId: customer.id,
    },
  });
  if (existing) {
    return { license: existing, created: false };
  }

  const result = await createLicense({
    customerId: customer.id,
    programId: program.id,
    source: LicenseSource.WEBSITE_ORDER,
    licenseDays: input.licenseDays ?? program.defaultLicenseDays,
    maxDevices: input.maxDevices ?? program.defaultMaxDevices,
    notes: noteMarker,
    sendMail: false,
    ipAddress: input.ipAddress,
  });

  return { license: result.license, created: true };
}

function successFromDelivery(
  program: Program,
  orderNo: string,
  delivery: {
    externalTenantId: string | null;
    externalTenantSlug: string | null;
    loginUrl: string | null;
    mailSent: boolean;
  },
  license: License,
  alreadyExists: boolean
): SaasOrderResult {
  return {
    ok: true,
    alreadyExists,
    deliveryType: 'SAAS',
    orderNo,
    programName: program.name,
    licenseKey: license.licenseKey,
    provisionStatus: ProvisionStatus.SUCCESS,
    externalTenantId: delivery.externalTenantId,
    externalTenantSlug: delivery.externalTenantSlug,
    loginUrl: delivery.loginUrl,
    mailSent: delivery.mailSent,
  };
}

function failureResult(
  program: Program,
  orderNo: string,
  error: string,
  license?: License,
  provisionStatus: ProvisionStatus = ProvisionStatus.FAILED
): SaasOrderResult {
  return {
    ok: false,
    deliveryType: 'SAAS',
    orderNo,
    programName: program.name,
    ...(license ? { licenseKey: license.licenseKey } : {}),
    error,
    provisionStatus,
  };
}

async function markProvisionFailed(orderNo: string, error: string, licenseId: string | null, now: Date) {
  await prisma.saasDelivery.update({
    where: { externalOrderId: orderNo },
    data: {
      provisionStatus: ProvisionStatus.FAILED,
      provisionError: error,
      lastProvisionAttemptAt: now,
      ...(licenseId ? { licenseId } : {}),
    },
  });
}

/**
 * SaaS sipariş teslimatı — önce merkezi WTG lisans kaydı, ardından hedef SaaS provision.
 */
export async function handleSaasWebsiteOrder(
  program: Program,
  customer: Customer,
  input: SaasOrderInput
): Promise<SaasOrderResult> {
  const targetService = program.targetService?.trim().toUpperCase();
  if (!targetService) {
    return failureResult(program, input.orderNo, SAAS_TARGET_SERVICE_MISSING);
  }

  const productCode = program.saasProductCode?.trim();
  if (!productCode) {
    return failureResult(program, input.orderNo, SAAS_PRODUCT_CODE_MISSING);
  }

  const { license } = await ensureWebsiteSaasLicense(program, customer, input);

  const now = new Date();
  const existing = await prisma.saasDelivery.findUnique({
    where: { externalOrderId: input.orderNo },
  });

  if (existing?.provisionStatus === ProvisionStatus.SUCCESS) {
    if (!existing.licenseId) {
      await prisma.saasDelivery.update({
        where: { externalOrderId: input.orderNo },
        data: { licenseId: license.id },
      });
    }
    return successFromDelivery(program, input.orderNo, existing, license, true);
  }

  if (!existing) {
    await prisma.saasDelivery.create({
      data: {
        externalOrderId: input.orderNo,
        customerId: customer.id,
        programId: program.id,
        licenseId: license.id,
        targetService,
        provisionStatus: ProvisionStatus.PENDING,
        lastProvisionAttemptAt: now,
      },
    });
  } else {
    await prisma.saasDelivery.update({
      where: { externalOrderId: input.orderNo },
      data: {
        licenseId: license.id,
        provisionStatus: ProvisionStatus.PENDING,
        provisionError: null,
        lastProvisionAttemptAt: now,
      },
    });
  }

  if (targetService !== MUVEKKIL_KASA_TARGET) {
    await markProvisionFailed(input.orderNo, SAAS_PROVISIONING_NOT_IMPLEMENTED, license.id, now);
    return failureResult(program, input.orderNo, SAAS_PROVISIONING_NOT_IMPLEMENTED, license);
  }

  const providerConfig = getSaasProviderConfig(targetService);
  if (!providerConfig) {
    await markProvisionFailed(input.orderNo, SAAS_PROVIDER_NOT_CONFIGURED, license.id, now);
    return failureResult(program, input.orderNo, SAAS_PROVIDER_NOT_CONFIGURED, license);
  }

  const licenseDays = input.licenseDays ?? program.defaultLicenseDays;
  const provision = await provisionMuvekkilKasaTenant(providerConfig, {
    externalOrderId: input.orderNo,
    externalCustomerId: customer.id,
    productCode,
    licenseDays,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    customerPhone: input.customerPhone ?? customer.phone,
  });

  if (!provision.ok) {
    await prisma.saasDelivery.update({
      where: { externalOrderId: input.orderNo },
      data: {
        licenseId: license.id,
        provisionStatus: ProvisionStatus.FAILED,
        provisionError: provision.error,
        lastProvisionAttemptAt: now,
        rawResponse: provision.raw ? (provision.raw as object) : undefined,
      },
    });

    console.error('[saas-delivery] provision failed', {
      orderNo: input.orderNo,
      appCode: program.appCode,
      licenseKey: license.licenseKey,
      targetService,
      error: provision.error,
      httpStatus: provision.httpStatus,
    });

    return failureResult(program, input.orderNo, provision.error, license);
  }

  const { data } = provision;
  const updated = await prisma.saasDelivery.update({
    where: { externalOrderId: input.orderNo },
    data: {
      licenseId: license.id,
      provisionStatus: ProvisionStatus.SUCCESS,
      provisionError: null,
      provisionedAt: now,
      lastProvisionAttemptAt: now,
      externalTenantId: data.tenantId,
      externalTenantSlug: data.tenantSlug,
      loginUrl: data.loginUrl || null,
      mailSent: data.mailSent,
      rawResponse: data.raw as object,
    },
  });

  console.info('[saas-delivery] provision success', {
    orderNo: input.orderNo,
    appCode: program.appCode,
    licenseKey: license.licenseKey,
    tenantId: data.tenantId,
    idempotentReplay: data.idempotentReplay,
    mailSent: data.mailSent,
  });

  return successFromDelivery(program, input.orderNo, updated, license, data.idempotentReplay);
}
