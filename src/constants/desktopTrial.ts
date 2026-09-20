export const APP_CODE_KOOPPLUS_DESKTOP = 'KOOPPLUS_DESKTOP';
export const APP_CODE_MUVEKKIL_KASA_DESKTOP = 'MUVEKKIL_KASA_DESKTOP';

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

export const MUVEKKIL_KASA_PROGRAM_DEFAULTS = {
  appCode: APP_CODE_MUVEKKIL_KASA_DESKTOP,
  name: 'Müvekkil Kasa Defteri Desktop',
  description: 'Müvekkil kasa defteri masaüstü uygulaması',
  defaultLicenseDays: 365,
  defaultMaxDevices: 1,
} as const;

export type DesktopTrialProgramConfig = {
  appCode: string;
  productName: string;
  trialDays: number;
  offlineGraceDays: number;
  systemCustomerEmail: string;
  systemCustomerName: string;
  systemCustomerNotes: string;
  alreadyUsedMessage: string;
  advisoryLockKey: number;
};

/** KoopPlus mesajı birebir korunur — mevcut client/test contract. */
export const KOOPPLUS_TRIAL_ALREADY_USED_MESSAGE =
  'Bu cihaz, e-posta adresi veya telefon numarası ile KoopPlus ücretsiz denemesi daha önce kullanılmış.';

export const MUVEKKIL_KASA_TRIAL_ALREADY_USED_MESSAGE =
  'Bu cihaz, e-posta adresi veya telefon numarası ile Müvekkil Kasa Defteri ücretsiz denemesi daha önce kullanılmış.';

export const DESKTOP_TRIAL_PROGRAMS: Record<string, DesktopTrialProgramConfig> = {
  [APP_CODE_KOOPPLUS_DESKTOP]: {
    appCode: APP_CODE_KOOPPLUS_DESKTOP,
    productName: KOOPPLUS_PROGRAM_DEFAULTS.name,
    trialDays: DESKTOP_TRIAL_DAYS,
    offlineGraceDays: DESKTOP_TRIAL_OFFLINE_GRACE_DAYS,
    systemCustomerEmail: 'system.koopplus.trial@internal.woontegra.local',
    systemCustomerName: 'SYSTEM / KoopPlus Trial',
    systemCustomerNotes:
      'Sistem kaydı — otomatik KoopPlus trial lisanslarının teknik sahibi. Gerçek müşteri değildir.',
    alreadyUsedMessage: KOOPPLUS_TRIAL_ALREADY_USED_MESSAGE,
    advisoryLockKey: 712409,
  },
  [APP_CODE_MUVEKKIL_KASA_DESKTOP]: {
    appCode: APP_CODE_MUVEKKIL_KASA_DESKTOP,
    productName: MUVEKKIL_KASA_PROGRAM_DEFAULTS.name,
    trialDays: DESKTOP_TRIAL_DAYS,
    offlineGraceDays: DESKTOP_TRIAL_OFFLINE_GRACE_DAYS,
    systemCustomerEmail: 'system.muvekkil-kasa.trial@internal.woontegra.local',
    systemCustomerName: 'SYSTEM / Müvekkil Kasa Trial',
    systemCustomerNotes:
      'Sistem kaydı — otomatik Müvekkil Kasa Defteri trial lisanslarının teknik sahibi. Gerçek müşteri değildir.',
    alreadyUsedMessage: MUVEKKIL_KASA_TRIAL_ALREADY_USED_MESSAGE,
    advisoryLockKey: 712411,
  },
};

/** Yalnız bu appCode'lar otomatik trial alabilir. Diğer ürünler etkilenmez. */
export const AUTO_TRIAL_APP_CODES = new Set<string>(Object.keys(DESKTOP_TRIAL_PROGRAMS));

export function getDesktopTrialProgramConfig(appCode: string): DesktopTrialProgramConfig | null {
  return DESKTOP_TRIAL_PROGRAMS[appCode] ?? null;
}

/** KoopPlus geriye uyum alias'ları — mevcut test/import contract. */
export const SYSTEM_TRIAL_CUSTOMER_EMAIL =
  DESKTOP_TRIAL_PROGRAMS[APP_CODE_KOOPPLUS_DESKTOP].systemCustomerEmail;
export const SYSTEM_TRIAL_CUSTOMER_NAME =
  DESKTOP_TRIAL_PROGRAMS[APP_CODE_KOOPPLUS_DESKTOP].systemCustomerName;
export const SYSTEM_TRIAL_CUSTOMER_NOTES =
  DESKTOP_TRIAL_PROGRAMS[APP_CODE_KOOPPLUS_DESKTOP].systemCustomerNotes;

export const SYSTEM_TRIAL_NOTES_PREFIX = 'SYSTEM_TRIAL:';

export function isSystemTrialLicenseNotes(notes: string | null | undefined): boolean {
  return typeof notes === 'string' && notes.startsWith(SYSTEM_TRIAL_NOTES_PREFIX);
}

export const DEVICE_HASH_SHA256_HEX = /^[a-fA-F0-9]{64}$/;

export const TRIAL_ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_DEVICE_HASH: 'INVALID_DEVICE_HASH',
  INVALID_EMAIL: 'INVALID_EMAIL',
  INVALID_PHONE: 'INVALID_PHONE',
  TRIAL_NOT_AVAILABLE_FOR_PRODUCT: 'TRIAL_NOT_AVAILABLE_FOR_PRODUCT',
  PROGRAM_NOT_FOUND_OR_INACTIVE: 'PROGRAM_NOT_FOUND_OR_INACTIVE',
  TRIAL_ALREADY_USED: 'TRIAL_ALREADY_USED',
  TRIAL_EXPIRED: 'TRIAL_EXPIRED',
  TRIAL_NOT_FOUND: 'TRIAL_NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type TrialErrorCode = (typeof TRIAL_ERROR_CODES)[keyof typeof TRIAL_ERROR_CODES];
