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
