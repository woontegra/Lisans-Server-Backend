export const APP_CODE_AKTUERYA_DESKTOP = 'AKTUERYA_DESKTOP';
export const APP_CODE_AKTUERYA_SAAS = 'AKTUERYA_SAAS';

export const SAAS_TARGET_MUVEKKIL_KASA = 'MUVEKKIL_KASA';
export const SAAS_TARGET_AKTUERYA = 'AKTUERYA';
export const SAAS_PRODUCT_CODE_AKTUERYA = 'AKTUERYA_SAAS';

export const ALLOWED_SAAS_TARGETS = [SAAS_TARGET_MUVEKKIL_KASA, SAAS_TARGET_AKTUERYA] as const;

export function normalizeSaasTargetService(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase();
}
