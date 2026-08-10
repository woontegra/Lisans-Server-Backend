import {
  DeviceStatus,
  LicenseEventType,
  LicenseStatus,
  type License,
  type Program,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logLicenseEvent } from './licenseService';
import { isDesktopProgram } from './saasOrderService';

export class WebsiteRenewalError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WebsiteRenewalError';
  }
}

/** Woontegra Website desktopLicenseExtend ile uyumlu gün başı. */
export function dayStart(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Aktif: mevcut bitişten; süresi dolmuş: ödeme/bugün başlangıcından uzat. */
export function computeExtensionBaseDate(expiresAt: Date, ref = new Date()): Date {
  const today = dayStart(ref);
  const endDay = dayStart(expiresAt);
  if (endDay.getTime() >= today.getTime()) return new Date(expiresAt);
  return today;
}

export function addDaysFromBase(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function normalizeLicenseKey(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

function normalizeAppCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export type RenewWebsiteLicenseInput = {
  orderNo: string;
  licenseKey: string;
  licenseId?: string | null;
  appCode: string;
  licenseDays: number;
  ipAddress?: string;
};

export type RenewWebsiteLicenseResult = {
  success: true;
  alreadyRenewed: boolean;
  licenseKey: string;
  previousExpiresAt: string;
  newExpiresAt: string;
  status: LicenseStatus;
};

async function findLicenseForRenewal(input: {
  licenseKey: string;
  licenseId?: string | null;
}): Promise<(License & { program: Program }) | null> {
  const licenseKeyNorm = normalizeLicenseKey(input.licenseKey);
  if (input.licenseId?.trim()) {
    const byId = await prisma.license.findUnique({
      where: { id: input.licenseId.trim() },
      include: { program: true },
    });
    if (byId) return byId;
  }
  return prisma.license.findUnique({
    where: { licenseKey: licenseKeyNorm },
    include: { program: true },
  });
}

export async function renewWebsiteLicense(
  input: RenewWebsiteLicenseInput,
): Promise<RenewWebsiteLicenseResult> {
  const orderNo = input.orderNo.trim();
  const licenseKeyNorm = normalizeLicenseKey(input.licenseKey);
  const appCode = normalizeAppCode(input.appCode);
  const renewalDays = Math.max(1, Math.floor(input.licenseDays));

  if (!orderNo || !licenseKeyNorm || !appCode) {
    throw new WebsiteRenewalError(
      'orderNo, licenseKey ve appCode zorunludur',
      'VALIDATION',
      400,
    );
  }

  const existingRenewal = await prisma.websiteLicenseRenewal.findUnique({
    where: { externalOrderId: orderNo },
    include: { license: true },
  });
  if (existingRenewal) {
    return {
      success: true,
      alreadyRenewed: true,
      licenseKey: existingRenewal.license.licenseKey,
      previousExpiresAt: existingRenewal.previousExpiresAt.toISOString(),
      newExpiresAt: existingRenewal.newExpiresAt.toISOString(),
      status: existingRenewal.license.status,
    };
  }

  const license = await findLicenseForRenewal({
    licenseKey: licenseKeyNorm,
    licenseId: input.licenseId,
  });
  if (!license) {
    throw new WebsiteRenewalError('Lisans bulunamadı', 'LICENSE_NOT_FOUND', 404);
  }
  if (license.licenseKey !== licenseKeyNorm) {
    throw new WebsiteRenewalError('Lisans anahtarı eşleşmiyor', 'LICENSE_KEY_MISMATCH', 400);
  }
  if (license.program.appCode !== appCode) {
    throw new WebsiteRenewalError('Program kodu eşleşmiyor', 'APP_CODE_MISMATCH', 400);
  }
  if (!isDesktopProgram(license.program)) {
    throw new WebsiteRenewalError(
      'Bu ürün için yenileme desteklenmiyor',
      'NOT_DESKTOP_PRODUCT',
      400,
    );
  }
  if (license.status === LicenseStatus.PASSIVE) {
    throw new WebsiteRenewalError('Lisans pasif durumda', 'LICENSE_PASSIVE', 400);
  }

  const previousExpiresAt = new Date(license.expiresAt);
  const baseDate = computeExtensionBaseDate(previousExpiresAt);
  const newExpiresAt = addDaysFromBase(baseDate, renewalDays);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const renewalRecord = await tx.websiteLicenseRenewal.create({
        data: {
          externalOrderId: orderNo,
          licenseId: license.id,
          renewalDays,
          previousExpiresAt,
          newExpiresAt,
        },
      });

      const updated = await tx.license.update({
        where: { id: license.id },
        data: {
          expiresAt: newExpiresAt,
          status: LicenseStatus.ACTIVE,
        },
      });

      await tx.licenseEvent.create({
        data: {
          licenseId: license.id,
          eventType: LicenseEventType.LICENSE_EXTENDED,
          message: `Website yenileme no: ${orderNo} | ${renewalDays} gün | önceki: ${previousExpiresAt.toISOString()} | yeni: ${newExpiresAt.toISOString()}`,
          ipAddress: input.ipAddress,
        },
      });

      return { updated, renewalRecord };
    });

    return {
      success: true,
      alreadyRenewed: false,
      licenseKey: result.updated.licenseKey,
      previousExpiresAt: previousExpiresAt.toISOString(),
      newExpiresAt: newExpiresAt.toISOString(),
      status: result.updated.status,
    };
  } catch (e) {
    const isUniqueViolation =
      e instanceof Error &&
      (e.message.includes('Unique constraint') ||
        e.message.includes('WebsiteLicenseRenewal_externalOrderId_key'));
    if (isUniqueViolation) {
      const replay = await prisma.websiteLicenseRenewal.findUnique({
        where: { externalOrderId: orderNo },
        include: { license: true },
      });
      if (replay) {
        return {
          success: true,
          alreadyRenewed: true,
          licenseKey: replay.license.licenseKey,
          previousExpiresAt: replay.previousExpiresAt.toISOString(),
          newExpiresAt: replay.newExpiresAt.toISOString(),
          status: replay.license.status,
        };
      }
    }
    throw e;
  }
}

export type DesktopRenewalOpenInput = {
  licenseKey: string;
  deviceHash: string;
  appCode: string;
};

export type DesktopRenewalOpenResult = {
  licenseId: string;
  customerNumber: string | null;
  customerName: string;
  expiresAt: string;
};

export async function openDesktopRenewal(
  input: DesktopRenewalOpenInput,
): Promise<DesktopRenewalOpenResult> {
  const licenseKey = normalizeLicenseKey(input.licenseKey);
  const deviceHash = input.deviceHash.trim();
  const appCode = normalizeAppCode(input.appCode);

  if (!licenseKey || !deviceHash || !appCode) {
    throw new WebsiteRenewalError(
      'licenseKey, deviceHash ve appCode zorunludur',
      'VALIDATION',
      400,
    );
  }

  const license = await prisma.license.findUnique({
    where: { licenseKey },
    include: { program: true, customer: true },
  });
  if (!license) {
    throw new WebsiteRenewalError('Lisans bulunamadı', 'LICENSE_NOT_FOUND', 404);
  }
  if (license.program.appCode !== appCode) {
    throw new WebsiteRenewalError('Program kodu eşleşmiyor', 'APP_CODE_MISMATCH', 400);
  }
  if (!isDesktopProgram(license.program)) {
    throw new WebsiteRenewalError(
      'Bu ürün için yenileme desteklenmiyor',
      'NOT_DESKTOP_PRODUCT',
      400,
    );
  }

  const device = await prisma.licenseDevice.findUnique({
    where: {
      licenseId_deviceHash: {
        licenseId: license.id,
        deviceHash,
      },
    },
  });
  if (!device || device.status !== DeviceStatus.ACTIVE) {
    throw new WebsiteRenewalError('Cihaz kayıtlı değil', 'DEVICE_NOT_REGISTERED', 404);
  }

  await logLicenseEvent(
    license.id,
    LicenseEventType.VALIDATED,
    `Desktop yenileme oturumu açıldı: ${deviceHash}`,
  );

  return {
    licenseId: license.id,
    customerNumber: null,
    customerName: license.customer.name,
    expiresAt: license.expiresAt.toISOString(),
  };
}
