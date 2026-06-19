import {
  LicenseEventType,
  LicenseSource,
  LicenseStatus,
  Prisma,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { generateActivationPassword, generateLicenseKey } from '../utils/licenseKey';
import { hashPassword } from '../utils/password';
import { isLicenseExpired, resolveLicenseStatus } from '../utils/license';
import { sendLicenseMail } from './mailService';

async function createUniqueLicenseKey(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const key = generateLicenseKey();
    const existing = await prisma.license.findUnique({ where: { licenseKey: key } });
    if (!existing) return key;
  }
  throw new Error('Lisans anahtarı üretilemedi');
}

export async function logLicenseEvent(
  licenseId: string,
  eventType: LicenseEventType,
  message?: string,
  ipAddress?: string
) {
  await prisma.licenseEvent.create({
    data: { licenseId, eventType, message, ipAddress },
  });
}

export interface CreateLicenseInput {
  customerId: string;
  programId: string;
  source?: LicenseSource;
  startsAt?: Date;
  expiresAt?: Date;
  licenseDays?: number;
  maxDevices?: number;
  notes?: string;
  sendMail?: boolean;
  downloadUrl?: string;
  ipAddress?: string;
}

export interface CreateLicenseResult {
  license: Prisma.LicenseGetPayload<{
    include: { customer: true; program: true; devices: true };
  }>;
  activationPassword: string;
  mailResult?: { sent: boolean; error?: string };
}

export async function createLicense(input: CreateLicenseInput): Promise<CreateLicenseResult> {
  const program = await prisma.program.findUnique({ where: { id: input.programId } });
  if (!program) throw new Error('Program bulunamadı');

  const customer = await prisma.customer.findUnique({ where: { id: input.customerId } });
  if (!customer) throw new Error('Müşteri bulunamadı');

  const startsAt = input.startsAt || new Date();
  let expiresAt: Date;
  if (input.expiresAt) {
    expiresAt = input.expiresAt;
  } else {
    const days = input.licenseDays ?? program.defaultLicenseDays;
    expiresAt = new Date(startsAt);
    expiresAt.setDate(expiresAt.getDate() + days);
  }

  const licenseKey = await createUniqueLicenseKey();
  const activationPassword = generateActivationPassword();
  const activationPasswordHash = await hashPassword(activationPassword);

  const license = await prisma.license.create({
    data: {
      licenseKey,
      activationPasswordHash,
      customerId: input.customerId,
      programId: input.programId,
      source: input.source || LicenseSource.MANUAL,
      startsAt,
      expiresAt,
      maxDevices: input.maxDevices ?? program.defaultMaxDevices,
      notes: input.notes,
      status: LicenseStatus.ACTIVE,
    },
    include: { customer: true, program: true, devices: true },
  });

  await logLicenseEvent(
    license.id,
    LicenseEventType.LICENSE_CREATED,
    `Lisans oluşturuldu: ${licenseKey}`,
    input.ipAddress
  );

  let mailResult: { sent: boolean; error?: string } | undefined;
  if (input.sendMail) {
    mailResult = await sendLicenseMail({
      programName: program.name,
      customerEmail: customer.email,
      customerName: customer.name,
      licenseKey,
      activationPassword,
      downloadUrl: input.downloadUrl,
      expiresAt,
    });
    await logLicenseEvent(
      license.id,
      LicenseEventType.MAIL_SENT,
      mailResult.sent ? 'Lisans maili gönderildi' : mailResult.error,
      input.ipAddress
    );
  }

  return { license, activationPassword, mailResult };
}

export interface ActivateInput {
  licenseKey: string;
  activationPassword: string;
  appCode: string;
  deviceHash: string;
  deviceName?: string;
  platform?: string;
  appVersion?: string;
  ipAddress?: string;
}

export async function activateLicense(input: ActivateInput) {
  const license = await prisma.license.findUnique({
    where: { licenseKey: input.licenseKey },
    include: { program: true, devices: { where: { status: 'ACTIVE' } } },
  });

  if (!license) {
    return { success: false, message: 'Lisans bulunamadı' };
  }

  if (license.program.appCode !== input.appCode) {
    await logLicenseEvent(
      license.id,
      LicenseEventType.VALIDATION_FAILED,
      `Yanlış appCode: ${input.appCode}`,
      input.ipAddress
    );
    return { success: false, message: 'Program kodu eşleşmiyor' };
  }

  const effectiveStatus = resolveLicenseStatus(license.status, license.expiresAt);
  if (effectiveStatus === LicenseStatus.PASSIVE) {
    return { success: false, message: 'Lisans pasif durumda' };
  }
  if (effectiveStatus === LicenseStatus.EXPIRED || isLicenseExpired(license.expiresAt)) {
    if (license.status !== LicenseStatus.EXPIRED) {
      await prisma.license.update({
        where: { id: license.id },
        data: { status: LicenseStatus.EXPIRED },
      });
    }
    return { success: false, message: 'Lisans süresi dolmuş' };
  }

  const passwordValid = await import('../utils/password').then((m) =>
    m.verifyPassword(input.activationPassword, license.activationPasswordHash)
  );
  if (!passwordValid) {
    await logLicenseEvent(
      license.id,
      LicenseEventType.VALIDATION_FAILED,
      'Yanlış aktivasyon şifresi',
      input.ipAddress
    );
    return { success: false, message: 'Aktivasyon şifresi hatalı' };
  }

  const existingDevice = await prisma.licenseDevice.findUnique({
    where: {
      licenseId_deviceHash: {
        licenseId: license.id,
        deviceHash: input.deviceHash,
      },
    },
  });

  if (existingDevice) {
    if (existingDevice.status === 'REVOKED') {
      return { success: false, message: 'Bu cihazın erişimi iptal edilmiş' };
    }
    const updated = await prisma.licenseDevice.update({
      where: { id: existingDevice.id },
      data: {
        lastValidatedAt: new Date(),
        deviceName: input.deviceName,
        platform: input.platform,
        appVersion: input.appVersion,
      },
    });
    await logLicenseEvent(
      license.id,
      LicenseEventType.ACTIVATED,
      `Mevcut cihaz yeniden doğrulandı: ${input.deviceHash}`,
      input.ipAddress
    );
    return {
      success: true,
      message: 'Cihaz zaten aktif',
      device: updated,
      expiresAt: license.expiresAt,
    };
  }

  const activeDeviceCount = license.devices.length;
  if (activeDeviceCount >= license.maxDevices) {
    return {
      success: false,
      message: `Cihaz limiti aşıldı (${license.maxDevices} cihaz)`,
    };
  }

  const device = await prisma.licenseDevice.create({
    data: {
      licenseId: license.id,
      deviceHash: input.deviceHash,
      deviceName: input.deviceName,
      platform: input.platform,
      appVersion: input.appVersion,
    },
  });

  await logLicenseEvent(
    license.id,
    LicenseEventType.ACTIVATED,
    `Yeni cihaz aktive edildi: ${input.deviceName || input.deviceHash}`,
    input.ipAddress
  );

  return {
    success: true,
    message: 'Lisans başarıyla aktive edildi',
    device,
    expiresAt: license.expiresAt,
  };
}

export interface ValidateInput {
  licenseKey: string;
  appCode: string;
  deviceHash: string;
  ipAddress?: string;
}

export async function validateLicense(input: ValidateInput) {
  const license = await prisma.license.findUnique({
    where: { licenseKey: input.licenseKey },
    include: { program: true },
  });

  if (!license) {
    return {
      valid: false,
      message: 'Lisans bulunamadı',
    };
  }

  if (license.program.appCode !== input.appCode) {
    await logLicenseEvent(
      license.id,
      LicenseEventType.VALIDATION_FAILED,
      `Validate: yanlış appCode`,
      input.ipAddress
    );
    return {
      valid: false,
      licenseKey: license.licenseKey,
      appCode: license.program.appCode,
      message: 'Program kodu eşleşmiyor',
    };
  }

  const device = await prisma.licenseDevice.findUnique({
    where: {
      licenseId_deviceHash: {
        licenseId: license.id,
        deviceHash: input.deviceHash,
      },
    },
  });

  if (!device || device.status !== 'ACTIVE') {
    await logLicenseEvent(
      license.id,
      LicenseEventType.VALIDATION_FAILED,
      'Kayıtlı olmayan veya iptal edilmiş cihaz',
      input.ipAddress
    );
    return {
      valid: false,
      licenseKey: license.licenseKey,
      appCode: license.program.appCode,
      message: 'Cihaz kayıtlı değil',
    };
  }

  const effectiveStatus = resolveLicenseStatus(license.status, license.expiresAt);
  if (effectiveStatus === LicenseStatus.EXPIRED || isLicenseExpired(license.expiresAt)) {
    if (license.status !== LicenseStatus.EXPIRED) {
      await prisma.license.update({
        where: { id: license.id },
        data: { status: LicenseStatus.EXPIRED },
      });
    }
    return {
      valid: false,
      licenseKey: license.licenseKey,
      appCode: license.program.appCode,
      expiresAt: license.expiresAt,
      status: LicenseStatus.EXPIRED,
      message: 'Lisans süresi dolmuş',
    };
  }

  if (effectiveStatus === LicenseStatus.PASSIVE) {
    return {
      valid: false,
      licenseKey: license.licenseKey,
      appCode: license.program.appCode,
      expiresAt: license.expiresAt,
      status: LicenseStatus.PASSIVE,
      message: 'Lisans pasif durumda',
    };
  }

  await prisma.licenseDevice.update({
    where: { id: device.id },
    data: { lastValidatedAt: new Date() },
  });

  await logLicenseEvent(
    license.id,
    LicenseEventType.VALIDATED,
    `Cihaz doğrulandı: ${input.deviceHash}`,
    input.ipAddress
  );

  const { config } = await import('../config');

  return {
    valid: true,
    licenseKey: license.licenseKey,
    appCode: license.program.appCode,
    expiresAt: license.expiresAt,
    status: effectiveStatus,
    maxDevices: license.maxDevices,
    offlineGraceDays: config.offlineGraceDays,
    message: 'Lisans geçerli',
  };
}

export async function extendLicense(
  licenseId: string,
  days: number,
  ipAddress?: string
) {
  const license = await prisma.license.findUnique({ where: { id: licenseId } });
  if (!license) throw new Error('Lisans bulunamadı');

  const baseDate = license.expiresAt > new Date() ? license.expiresAt : new Date();
  const newExpiresAt = new Date(baseDate);
  newExpiresAt.setDate(newExpiresAt.getDate() + days);

  const updated = await prisma.license.update({
    where: { id: licenseId },
    data: {
      expiresAt: newExpiresAt,
      status: LicenseStatus.ACTIVE,
    },
    include: { customer: true, program: true, devices: true },
  });

  await logLicenseEvent(
    licenseId,
    LicenseEventType.LICENSE_EXTENDED,
    `${days} gün uzatıldı. Yeni bitiş: ${newExpiresAt.toISOString()}`,
    ipAddress
  );

  return updated;
}

export async function regenerateActivationPassword(licenseId: string, ipAddress?: string) {
  const activationPassword = generateActivationPassword();
  const activationPasswordHash = await hashPassword(activationPassword);

  await prisma.license.update({
    where: { id: licenseId },
    data: { activationPasswordHash },
  });

  await logLicenseEvent(
    licenseId,
    LicenseEventType.PASSWORD_REGENERATED,
    'Aktivasyon şifresi yenilendi',
    ipAddress
  );

  return activationPassword;
}

export async function resetDevices(licenseId: string, ipAddress?: string) {
  await prisma.licenseDevice.updateMany({
    where: { licenseId, status: 'ACTIVE' },
    data: { status: 'REVOKED' },
  });

  await logLicenseEvent(
    licenseId,
    LicenseEventType.DEVICE_RESET,
    'Tüm cihazlar sıfırlandı',
    ipAddress
  );
}
