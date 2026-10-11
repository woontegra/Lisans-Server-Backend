export type DesktopEntitlementPlatform = 'WINDOWS' | 'MACOS';

/** win32 / windows / darwin / macos değerlerini entitlement platformuna çevirir. */
export function normalizeDesktopEntitlementPlatform(raw: unknown): DesktopEntitlementPlatform | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value === 'windows' || value.startsWith('win32') || value.startsWith('win64') || value.startsWith('windows')) {
    return 'WINDOWS';
  }
  if (value === 'macos' || value === 'mac' || value.startsWith('darwin') || value.startsWith('macos')) {
    return 'MACOS';
  }
  return null;
}

export function entitlementPlatformMismatch(
  licensePlatform: string | null | undefined,
  requestPlatform: unknown
): boolean {
  if (!licensePlatform) return false;
  const required = normalizeDesktopEntitlementPlatform(licensePlatform);
  if (!required) return false;
  return normalizeDesktopEntitlementPlatform(requestPlatform) !== required;
}

/** MK Desktop 0.1.14 /validate isteğinde platform göndermez; aktivasyonda cihaza yazılan platform kullanılır. */
const DEVICE_PLATFORM_FALLBACK_APP_CODES = new Set(['MUVEKKIL_KASA_DESKTOP']);

export function validationPlatformMismatch(input: {
  appCode: string;
  licensePlatform: string | null | undefined;
  requestPlatform: unknown;
  device: { platform: string | null } | null;
}): boolean {
  const requestHasPlatform = typeof input.requestPlatform === 'string' && input.requestPlatform.trim() !== '';
  if (!requestHasPlatform && DEVICE_PLATFORM_FALLBACK_APP_CODES.has(input.appCode)) {
    if (!input.device) return false;
    return entitlementPlatformMismatch(input.licensePlatform, input.device.platform);
  }
  return entitlementPlatformMismatch(input.licensePlatform, input.requestPlatform);
}

/** Platformu henüz zorunlu olmayan sipariş: boşsa null, doluysa WINDOWS/MACOS olmalı. */
export function resolveOptionalOrderPlatform(
  raw: unknown
): { ok: true; platform: DesktopEntitlementPlatform | null } | { ok: false } {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return { ok: true, platform: null };
  const platform = normalizeDesktopEntitlementPlatform(raw);
  return platform ? { ok: true, platform } : { ok: false };
}

export class LicensePlatformRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LicensePlatformRequiredError';
  }
}

/**
 * Yeni ücretli BILIRKISI_DESKTOP lisansı WINDOWS veya MACOS olmadan açılamaz.
 * Diğer programlar platform göndermezse null kalır.
 */
export function resolvePaidLicensePlatform(appCode: string, raw: unknown): DesktopEntitlementPlatform | null {
  const platform = normalizeDesktopEntitlementPlatform(raw);
  if (appCode === 'BILIRKISI_DESKTOP' && !platform) {
    throw new LicensePlatformRequiredError(
      'Bilirkişi Desktop lisansı için platform WINDOWS veya MACOS olmalıdır'
    );
  }
  return platform;
}
