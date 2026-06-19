import { LicenseStatus } from '@prisma/client';

export function isLicenseExpired(expiresAt: Date): boolean {
  return new Date() > expiresAt;
}

export function resolveLicenseStatus(
  status: LicenseStatus,
  expiresAt: Date
): LicenseStatus {
  if (status === LicenseStatus.PASSIVE) {
    return LicenseStatus.PASSIVE;
  }
  if (isLicenseExpired(expiresAt)) {
    return LicenseStatus.EXPIRED;
  }
  return status;
}

export function daysUntilExpiry(expiresAt: Date): number {
  const now = new Date();
  const diff = expiresAt.getTime() - now.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}
