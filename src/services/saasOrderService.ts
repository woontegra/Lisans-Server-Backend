import { ProgramProductType, ProvisionStatus, type Customer, type Program } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getSaasProviderConfig, SAAS_PROVISIONING_NOT_IMPLEMENTED } from '../config/saasProviders';

export type SaasOrderInput = {
  customerId: string;
  customerName: string;
  customerEmail: string;
  orderNo: string;
  licenseDays?: number;
};

export type SaasOrderResult =
  | {
      ok: true;
      alreadyExists: true;
      deliveryType: 'SAAS';
      orderNo: string;
      programName: string;
      provisionStatus: ProvisionStatus;
      externalTenantId?: string | null;
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

export function isSaasProgram(program: Program): boolean {
  return program.productType === ProgramProductType.SAAS;
}

export function isDesktopProgram(program: Program): boolean {
  return program.productType === ProgramProductType.DESKTOP;
}

/**
 * SaaS sipariş teslimatı — P0: provisioning client yok; SaasDelivery kaydı + kontrollü hata.
 */
export async function handleSaasWebsiteOrder(
  program: Program,
  customer: Customer,
  input: SaasOrderInput
): Promise<SaasOrderResult> {
  const targetService = program.targetService?.trim();
  if (!targetService) {
    return {
      ok: false,
      deliveryType: 'SAAS',
      orderNo: input.orderNo,
      programName: program.name,
      error: 'SAAS_TARGET_SERVICE_MISSING',
      provisionStatus: ProvisionStatus.FAILED,
    };
  }

  const now = new Date();
  const existing = await prisma.saasDelivery.findUnique({
    where: { externalOrderId: input.orderNo },
  });

  if (existing?.provisionStatus === ProvisionStatus.SUCCESS) {
    return {
      ok: true,
      alreadyExists: true,
      deliveryType: 'SAAS',
      orderNo: input.orderNo,
      programName: program.name,
      provisionStatus: ProvisionStatus.SUCCESS,
      externalTenantId: existing.externalTenantId,
      loginUrl: existing.loginUrl,
      mailSent: existing.mailSent,
    };
  }

  const providerConfig = getSaasProviderConfig(targetService);
  const provisionError = SAAS_PROVISIONING_NOT_IMPLEMENTED;

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
  }

  await prisma.saasDelivery.update({
    where: { externalOrderId: input.orderNo },
    data: {
      provisionStatus: ProvisionStatus.FAILED,
      provisionError,
      lastProvisionAttemptAt: now,
    },
  });

  console.info('[saas-delivery] provisioning not implemented', {
    orderNo: input.orderNo,
    appCode: program.appCode,
    targetService,
    hasProviderConfig: !!providerConfig,
  });

  return {
    ok: false,
    deliveryType: 'SAAS',
    orderNo: input.orderNo,
    programName: program.name,
    error: provisionError,
    provisionStatus: ProvisionStatus.FAILED,
  };
}
