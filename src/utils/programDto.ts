import { ProgramProductType } from '@prisma/client';
import type { Program } from '@prisma/client';

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
  if (!targetService?.trim()) return 'SAAS programları için targetService zorunludur';
  if (!saasProductCode?.trim()) return 'SAAS programları için saasProductCode zorunludur';
  return null;
}
