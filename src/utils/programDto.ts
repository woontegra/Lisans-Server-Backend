import { ProgramProductType } from '@prisma/client';
import type { Program } from '@prisma/client';
import {
  ALLOWED_SAAS_TARGETS,
  SAAS_PRODUCT_CODE_AKTUERYA,
  SAAS_TARGET_AKTUERYA,
  normalizeSaasTargetService,
} from '../constants/aktuerya';

export type ProgramDto = {
  appCode: string;
  name: string;
  isActive: boolean;
  productType: ProgramProductType;
  targetService: string | null;
  saasProductCode: string | null;
  defaultLicenseDays: number;
  defaultMaxDevices: number;
  description: string | null;
};

export function toProgramDto(program: Program): ProgramDto {
  return {
    appCode: program.appCode,
    name: program.name,
    isActive: program.isActive,
    productType: program.productType,
    targetService: program.targetService ?? null,
    saasProductCode: program.saasProductCode ?? null,
    defaultLicenseDays: program.defaultLicenseDays,
    defaultMaxDevices: program.defaultMaxDevices,
    description: program.description ?? null,
  };
}

export function parseProductType(raw: unknown): ProgramProductType {
  const v = String(raw ?? 'DESKTOP').trim().toUpperCase();
  if (v === 'SAAS') return ProgramProductType.SAAS;
  return ProgramProductType.DESKTOP;
}

export function validateSaasProgramFields(
  productType: ProgramProductType,
  targetService?: string | null,
  saasProductCode?: string | null
): string | null {
  if (productType !== ProgramProductType.SAAS) return null;
  const target = normalizeSaasTargetService(targetService);
  if (!target) return 'SAAS programları için targetService zorunludur';
  if (!ALLOWED_SAAS_TARGETS.includes(target as (typeof ALLOWED_SAAS_TARGETS)[number])) {
    return 'SAAS targetService yalnızca MUVEKKIL_KASA veya AKTUERYA olabilir';
  }
  const productCode = String(saasProductCode ?? '').trim();
  if (!productCode) return 'SAAS programları için saasProductCode zorunludur';
  if (target === SAAS_TARGET_AKTUERYA && productCode !== SAAS_PRODUCT_CODE_AKTUERYA) {
    return 'AKTUERYA targetService için saasProductCode AKTUERYA_SAAS olmalıdır';
  }
  return null;
}
