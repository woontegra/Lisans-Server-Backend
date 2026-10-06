import {
  LicenseSource,
  ProgramProductType,
  ProvisionStatus,
  type Customer,
  type License,
  type Prisma,
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
import {
  APP_CODE_AKTUERYA_SAAS,
  normalizeSaasTargetService,
  SAAS_TARGET_AKTUERYA,
  SAAS_TARGET_MUVEKKIL_KASA,
} from '../constants/aktuerya';
import { provisionMuvekkilKasaTenant } from './muvekkilKasaProvisioner';
import {
  provisionAktueryaSaas,
  type AktueryaPlan,
  type AktueryaProvisionPayload,
} from './aktueryaProvisioner';

export type SaasOrderInput = {
  customerId: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  orderNo: string;
  licenseDays?: number;
  maxDevices?: number;
  ipAddress?: string;
  /** Yalnız AKTUERYA_SAAS. licenseDays üzerinden türetilmez. */
  plan?: AktueryaPlan;
  paidAt?: string;
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
      aktueryaUserId?: string;
      aktueryaSubscriptionId?: string;
      provisionResult?: AktueryaProvisionPayload['result'];
      subscriptionStartsAt?: string;
      subscriptionExpiresAt?: string;
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

const MUVEKKIL_KASA_TARGET = SAAS_TARGET_MUVEKKIL_KASA;
export const AKTUERYA_PLAN_REQUIRED = 'AKTUERYA_PLAN_REQUIRED';

export function isAktueryaSaasProgram(program: {
  productType: ProgramProductType;
  appCode: string;
  targetService?: string | null;
}): boolean {
  if (program.productType !== ProgramProductType.SAAS) return false;
  return (
    program.appCode === APP_CODE_AKTUERYA_SAAS ||
    normalizeSaasTargetService(program.targetService) === SAAS_TARGET_AKTUERYA
  );
}

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

function aktueryaMetaFromRaw(raw: Prisma.JsonValue | null | undefined): AktueryaProvisionPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const userId = typeof record.userId === 'string' ? record.userId : '';
  const subscriptionId = typeof record.subscriptionId === 'string' ? record.subscriptionId : '';
  const startsAt = typeof record.startsAt === 'string' ? record.startsAt : '';
  const expiresAt = typeof record.expiresAt === 'string' ? record.expiresAt : '';
  const result = record.result;
  const plan = record.plan;
  if (!userId || !subscriptionId || !startsAt || !expiresAt) return null;
  if (result !== 'CREATED' && result !== 'CONVERTED' && result !== 'RENEWED') return null;
  if (plan !== 'monthly' && plan !== 'yearly') return null;
  return {
    idempotentReplay: record.idempotentReplay === true,
    result,
    userId,
    subscriptionId,
    plan,
    startsAt,
    expiresAt,
    mailSent: record.mailSent === true,
  };
}

function aktueryaFields(meta: AktueryaProvisionPayload | null) {
  if (!meta) return {};
  return {
    aktueryaUserId: meta.userId,
    aktueryaSubscriptionId: meta.subscriptionId,
    provisionResult: meta.result,
    subscriptionStartsAt: meta.startsAt,
    subscriptionExpiresAt: meta.expiresAt,
  };
}

function successFromDelivery(
  program: Program,
  orderNo: string,
  delivery: {
    externalTenantId: string | null;
    externalTenantSlug: string | null;
    loginUrl: string | null;
    mailSent: boolean;
    rawResponse?: Prisma.JsonValue | null;
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
    ...aktueryaFields(aktueryaMetaFromRaw(delivery.rawResponse)),
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

  if (targetService === SAAS_TARGET_AKTUERYA && input.plan !== 'monthly' && input.plan !== 'yearly') {
    return failureResult(program, input.orderNo, AKTUERYA_PLAN_REQUIRED);
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

  if (targetService === SAAS_TARGET_AKTUERYA) {
    return completeAktueryaProvision(program, input, license, productCode, now);
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

async function completeAktueryaProvision(
  program: Program,
  input: SaasOrderInput,
  license: License,
  productCode: string,
  now: Date
): Promise<SaasOrderResult> {
  const plan = input.plan;
  if (plan !== 'monthly' && plan !== 'yearly') {
    await markProvisionFailed(input.orderNo, AKTUERYA_PLAN_REQUIRED, license.id, now);
    return failureResult(program, input.orderNo, AKTUERYA_PLAN_REQUIRED, license);
  }

  const providerConfig = getSaasProviderConfig(SAAS_TARGET_AKTUERYA);
  if (!providerConfig) {
    await markProvisionFailed(input.orderNo, SAAS_PROVIDER_NOT_CONFIGURED, license.id, now);
    return failureResult(program, input.orderNo, SAAS_PROVIDER_NOT_CONFIGURED, license);
  }

  const provision = await provisionAktueryaSaas(providerConfig, {
    externalOrderId: input.orderNo,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    customerPhone: input.customerPhone,
    plan,
    paidAt: input.paidAt ?? now.toISOString(),
    productCode,
  });

  if (!provision.ok) {
    await prisma.saasDelivery.update({
      where: { externalOrderId: input.orderNo },
      data: {
        licenseId: license.id,
        provisionStatus: ProvisionStatus.FAILED,
        provisionError: provision.error,
        lastProvisionAttemptAt: now,
        rawResponse: (provision.raw ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });

    console.error('[saas-delivery] aktuerya provision failed', {
      orderNo: input.orderNo,
      appCode: program.appCode,
      error: provision.error,
      httpStatus: provision.httpStatus ?? null,
    });

    return failureResult(program, input.orderNo, provision.error, license);
  }

  const stored: AktueryaProvisionPayload = provision.data;
  const updated = await prisma.saasDelivery.update({
    where: { externalOrderId: input.orderNo },
    data: {
      licenseId: license.id,
      provisionStatus: ProvisionStatus.SUCCESS,
      provisionError: null,
      provisionedAt: now,
      lastProvisionAttemptAt: now,
      mailSent: stored.mailSent,
      rawResponse: stored,
    },
  });

  console.info('[saas-delivery] aktuerya provision success', {
    orderNo: input.orderNo,
    appCode: program.appCode,
    result: stored.result,
    idempotentReplay: stored.idempotentReplay,
    mailSent: stored.mailSent,
  });

  return successFromDelivery(program, input.orderNo, updated, license, stored.idempotentReplay);
}
