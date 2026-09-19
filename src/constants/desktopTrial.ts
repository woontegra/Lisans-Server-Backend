export const APP_CODE_KOOPPLUS_DESKTOP = 'KOOPPLUS_DESKTOP';

/** Yalnız bu appCode otomatik trial alabilir. Diğer ürünler etkilenmez. */
export const AUTO_TRIAL_APP_CODES = new Set<string>([APP_CODE_KOOPPLUS_DESKTOP]);

export const DESKTOP_TRIAL_DAYS = 7;
export const DESKTOP_TRIAL_OFFLINE_GRACE_DAYS = 0;

/**
 * KoopPlus Program hedef özellikleri.
 * Production kaydı bu fazda oluşturulmaz; seed/admin create aynı değerleri kullanır.
 * Paid offline grace Program kolonu değildir — global config.offlineGraceDays (7).
 */
export const KOOPPLUS_PROGRAM_DEFAULTS = {
  appCode: APP_CODE_KOOPPLUS_DESKTOP,
  name: 'KoopPlus',
  description: 'Kooperatif aidat ve yönetim masaüstü uygulaması',
  defaultLicenseDays: 365,
  defaultMaxDevices: 1,
} as const;

export const SYSTEM_TRIAL_CUSTOMER_EMAIL = 'system.koopplus.trial@internal.woontegra.local';
export const SYSTEM_TRIAL_CUSTOMER_NAME = 'SYSTEM / KoopPlus Trial';
export const SYSTEM_TRIAL_CUSTOMER_NOTES =
  'Sistem kaydı — otomatik KoopPlus trial lisanslarının teknik sahibi. Gerçek müşteri değildir.';

export const SYSTEM_TRIAL_NOTES_PREFIX = 'SYSTEM_TRIAL:';

export function isSystemTrialLicenseNotes(notes: string | null | undefined): boolean {
  return typeof notes === 'string' && notes.startsWith(SYSTEM_TRIAL_NOTES_PREFIX);
}

export const DEVICE_HASH_SHA256_HEX = /^[a-fA-F0-9]{64}$/;

export const TRIAL_ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_DEVICE_HASH: 'INVALID_DEVICE_HASH',
  TRIAL_NOT_AVAILABLE_FOR_PRODUCT: 'TRIAL_NOT_AVAILABLE_FOR_PRODUCT',
  PROGRAM_NOT_FOUND_OR_INACTIVE: 'PROGRAM_NOT_FOUND_OR_INACTIVE',
  TRIAL_ALREADY_USED: 'TRIAL_ALREADY_USED',
  TRIAL_EXPIRED: 'TRIAL_EXPIRED',
  TRIAL_NOT_FOUND: 'TRIAL_NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type TrialErrorCode = (typeof TRIAL_ERROR_CODES)[keyof typeof TRIAL_ERROR_CODES];
