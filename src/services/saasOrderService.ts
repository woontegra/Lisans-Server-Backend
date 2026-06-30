import { ProgramProductType, ProvisionStatus, type Customer, type Program } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  getSaasProviderConfig,
  SAAS_PRODUCT_CODE_MISSING,
  SAAS_PROVIDER_NOT_CONFIGURED,
  SAAS_PROVISIONING_NOT_IMPLEMENTED,
  SAAS_TARGET_SERVICE_MISSING,
} from '../config/saasProviders';
import { provisionMuvekkilKasaTenant } from './muvekkilKasaProvisioner';

export type SaasOrderInput = {
  customerId: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  orderNo: string;
  licenseDays?: number;
};

export type SaasOrderResult =
  | {
      ok: true;
      alreadyExists: boolean;
      deliveryType: 'SAAS';
      orderNo: string;
      programName: string;
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

function successFromDelivery(
  program: Program,
  orderNo: string,
  delivery: {
    externalTenantId: string | null;
    externalTenantSlug: string | null;
    loginUrl: string | null;
    mailSent: boolean;
  },
  alreadyExists: boolean
): SaasOrderResult {
  return {
    ok: true,
    alreadyExists,
    deliveryType: 'SAAS',
    orderNo,
    programName: program.name,
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
  provisionStatus: ProvisionStatus = ProvisionStatus.FAILED
): SaasOrderResult {
  return {
    ok: false,
    deliveryType: 'SAAS',
    orderNo,
    programName: program.name,
    error,
    provisionStatus,
  };
}

async function markProvisionFailed(orderNo: string, error: string, now: Date) {
  await prisma.saasDelivery.update({
    where: { externalOrderId: orderNo },
    data: {
      provisionStatus: ProvisionStatus.FAILED,
      provisionError: error,
      lastProvisionAttemptAt: now,
    },
  });
}

/**
 * SaaS sipariş teslimatı — desktop lisans/mail üretmez; hedef servise provision isteği atar.
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

  const now = new Date();
  const existing = await prisma.saasDelivery.findUnique({
    where: { externalOrderId: input.orderNo },
  });

  if (existing?.provisionStatus === ProvisionStatus.SUCCESS) {
    return successFromDelivery(program, input.orderNo, existing, true);
  }

  if (!existing) {
    await prisma.saasDelivery.create({
      data: {
        externalOrderId: input.orderNo,
        customerId: customer.id,
        programId: program.id,
        targetService,
        provisionStatus: ProvisionStatus.PENDING,
        lastProvisionAttemptAt: now,
      },
    });
  } else {
    await prisma.saasDelivery.update({
      where: { externalOrderId: input.orderNo },
      data: {
        provisionStatus: ProvisionStatus.PENDING,
        provisionError: null,
        lastProvisionAttemptAt: now,
      },
    });
  }

  if (targetService !== MUVEKKIL_KASA_TARGET) {
    await markProvisionFailed(input.orderNo, SAAS_PROVISIONING_NOT_IMPLEMENTED, now);
    return failureResult(program, input.orderNo, SAAS_PROVISIONING_NOT_IMPLEMENTED);
  }

  const productCode = program.saasProductCode?.trim();
  if (!productCode) {
    await markProvisionFailed(input.orderNo, SAAS_PRODUCT_CODE_MISSING, now);
    return failureResult(program, input.orderNo, SAAS_PRODUCT_CODE_MISSING);
  }

  const providerConfig = getSaasProviderConfig(targetService);
  if (!providerConfig) {
    await markProvisionFailed(input.orderNo, SAAS_PROVIDER_NOT_CONFIGURED, now);
    return failureResult(program, input.orderNo, SAAS_PROVIDER_NOT_CONFIGURED);
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
        provisionStatus: ProvisionStatus.FAILED,
        provisionError: provision.error,
        lastProvisionAttemptAt: now,
        rawResponse: provision.raw ? (provision.raw as object) : undefined,
      },
    });

    console.error('[saas-delivery] provision failed', {
      orderNo: input.orderNo,
      appCode: program.appCode,
      targetService,
      error: provision.error,
      httpStatus: provision.httpStatus,
    });

    return failureResult(program, input.orderNo, provision.error);
  }

  const { data } = provision;
  const updated = await prisma.saasDelivery.update({
    where: { externalOrderId: input.orderNo },
    data: {
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
    tenantId: data.tenantId,
    idempotentReplay: data.idempotentReplay,
    mailSent: data.mailSent,
  });

  return successFromDelivery(program, input.orderNo, updated, data.idempotentReplay);
}
