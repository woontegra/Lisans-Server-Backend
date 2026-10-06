import { createHash, randomBytes } from 'crypto';
import { LicenseSource, LicenseStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  APP_CODE_BILIRKISI_DESKTOP,
  DEVICE_HASH_SHA256_HEX,
  isSystemTrialLicenseNotes,
} from '../constants/desktopTrial';
import { normalizeDesktopEntitlementPlatform } from '../lib/desktopPlatform';
import { createLicense, regenerateActivationPassword } from './licenseService';

export const DESKTOP_PURCHASE_PURPOSE = 'FIRST_PURCHASE';
export const DESKTOP_PURCHASE_TTL_MS = 30 * 60 * 1000;
export const DESKTOP_PURCHASE_LICENSE_DAYS = 365;
export const DESKTOP_PURCHASE_MAX_DEVICES = 1;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class DesktopPurchaseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'DesktopPurchaseError';
  }
}

export function hashPurchaseToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function isOpaquePurchaseToken(raw: unknown): raw is string {
  return typeof raw === 'string' && TOKEN_PATTERN.test(raw) && !raw.includes('@') && !DEVICE_HASH_SHA256_HEX.test(raw);
}

function assertAppCode(raw: unknown): string {
  const appCode = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (appCode !== APP_CODE_BILIRKISI_DESKTOP) {
    throw new DesktopPurchaseError(
      'PURCHASE_PRODUCT_MISMATCH',
      'Satın alma geçişi yalnız Bilirkişi Desktop denemesi için açılır',
      400,
    );
  }
  return appCode;
}

function assertPlatform(raw: unknown) {
  const platform = normalizeDesktopEntitlementPlatform(raw);
  if (!platform) {
    throw new DesktopPurchaseError('PURCHASE_PLATFORM_REQUIRED', 'Platform WINDOWS veya MACOS olmalıdır', 400);
  }
  return platform;
}

function assertDeviceHash(raw: unknown): string {
  const deviceHash = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!DEVICE_HASH_SHA256_HEX.test(deviceHash)) {
    throw new DesktopPurchaseError('INVALID_DEVICE', 'Cihaz doğrulanamadı', 400);
  }
  return deviceHash;
}

function orderNote(orderNo: string): string {
  return `Website sipariş no: ${orderNo}`;
}

export async function issueDesktopPurchaseToken(input: {
  appCode?: unknown;
  deviceHash?: unknown;
  platform?: unknown;
}) {
  const appCode = assertAppCode(input.appCode);
  const platform = assertPlatform(input.platform);
  const deviceHash = assertDeviceHash(input.deviceHash);
  const program = await prisma.program.findUnique({ where: { appCode } });
  if (!program?.isActive) {
    throw new DesktopPurchaseError('PROGRAM_NOT_FOUND_OR_INACTIVE', 'Ürün bulunamadı', 404);
  }

  const grant = await prisma.desktopTrialGrant.findUnique({
    where: {
      programId_platformScope_deviceHash: {
        programId: program.id,
        platformScope: platform,
        deviceHash,
      },
    },
  });
  const now = new Date();
  if (!grant || !grant.deviceBound || grant.status !== 'ACTIVE' || grant.expiresAt <= now) {
    throw new DesktopPurchaseError(
      'TRIAL_NOT_ACTIVE',
      'Aktif deneme bulunamadı. Satın alma yalnız süren deneme cihazından açılır.',
      404,
    );
  }
  if (grant.platformScope !== platform) {
    throw new DesktopPurchaseError('PURCHASE_PLATFORM_MISMATCH', 'Deneme platformu eşleşmiyor', 400);
  }
  const email = grant.emailNormalized?.trim().toLowerCase() || '';
  if (!email || !email.includes('@')) {
    throw new DesktopPurchaseError('TRIAL_NOT_ACTIVE', 'Aktif deneme bulunamadı', 404);
  }

  const paidDevice = await prisma.licenseDevice.findFirst({
    where: {
      deviceHash,
      status: 'ACTIVE',
      license: {
        programId: program.id,
        platform,
        status: LicenseStatus.ACTIVE,
        expiresAt: { gt: now },
        NOT: { notes: { startsWith: 'SYSTEM_TRIAL:' } },
      },
    },
  });
  if (paidDevice) {
    throw new DesktopPurchaseError(
      'ALREADY_PAID',
      'Bu cihazın ücretli lisansı var. Yenileme satın alma sayfasından yapılmaz.',
      409,
    );
  }

  const consumed = await prisma.desktopPurchaseSession.findFirst({
    where: { grantId: grant.id, consumedAt: { not: null }, paidLicenseId: { not: null } },
  });
  if (consumed) {
    throw new DesktopPurchaseError('PURCHASE_ALREADY_COMPLETED', 'Bu deneme için satın alma tamamlanmış', 409);
  }

  await prisma.desktopPurchaseSession.updateMany({
    where: { grantId: grant.id, consumedAt: null },
    data: { expiresAt: now },
  });

  const purchaseToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + DESKTOP_PURCHASE_TTL_MS);
  await prisma.desktopPurchaseSession.create({
    data: {
      tokenHash: hashPurchaseToken(purchaseToken),
      grantId: grant.id,
      appCode,
      platform,
      deviceHash,
      emailNormalized: email,
      purpose: DESKTOP_PURCHASE_PURPOSE,
      expiresAt,
    },
  });

  return {
    success: true as const,
    purchaseToken,
    expiresAt: expiresAt.toISOString(),
  };
}

async function findSessionByToken(rawOrHash: { purchaseToken?: unknown; tokenHash?: unknown }) {
  const raw = typeof rawOrHash.purchaseToken === 'string' ? rawOrHash.purchaseToken.trim() : '';
  const givenHash = typeof rawOrHash.tokenHash === 'string' ? rawOrHash.tokenHash.trim().toLowerCase() : '';
  if (raw && !isOpaquePurchaseToken(raw)) {
    throw new DesktopPurchaseError('PURCHASE_TOKEN_INVALID', 'Satın alma bağlantısı geçersiz', 400);
  }
  if (givenHash && !/^[a-f0-9]{64}$/.test(givenHash)) {
    throw new DesktopPurchaseError('PURCHASE_TOKEN_INVALID', 'Satın alma bağlantısı geçersiz', 400);
  }
  const tokenHash = raw ? hashPurchaseToken(raw) : givenHash;
  if (raw && givenHash && tokenHash !== givenHash) {
    throw new DesktopPurchaseError('PURCHASE_TOKEN_INVALID', 'Satın alma bağlantısı geçersiz', 400);
  }
  if (!tokenHash) {
    throw new DesktopPurchaseError('PURCHASE_TOKEN_INVALID', 'Satın alma bağlantısı geçersiz', 400);
  }
  const session = await prisma.desktopPurchaseSession.findUnique({ where: { tokenHash } });
  if (!session || session.purpose !== DESKTOP_PURCHASE_PURPOSE) {
    throw new DesktopPurchaseError('PURCHASE_TOKEN_INVALID', 'Satın alma bağlantısı geçersiz', 404);
  }
  return session;
}

function assertUsableSession(session: {
  appCode: string;
  consumedAt: Date | null;
  expiresAt: Date;
  purpose: string;
}) {
  if (session.appCode !== APP_CODE_BILIRKISI_DESKTOP || session.purpose !== DESKTOP_PURCHASE_PURPOSE) {
    throw new DesktopPurchaseError('PURCHASE_PRODUCT_MISMATCH', 'Bu bağlantı Bilirkişi Desktop ilk satın alması için değil', 400);
  }
  if (session.consumedAt) {
    throw new DesktopPurchaseError('PURCHASE_TOKEN_USED', 'Bu satın alma bağlantısı kullanılmış', 409);
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw new DesktopPurchaseError('PURCHASE_TOKEN_EXPIRED', 'Satın alma bağlantısının süresi doldu', 410);
  }
}

export async function resolveDesktopPurchaseToken(input: { purchaseToken?: unknown }) {
  const session = await findSessionByToken(input);
  assertUsableSession(session);
  return {
    success: true as const,
    appCode: session.appCode,
    platform: session.platform,
    purpose: DESKTOP_PURCHASE_PURPOSE,
    fromTrial: true,
    licenseDays: DESKTOP_PURCHASE_LICENSE_DAYS,
    maxDevices: DESKTOP_PURCHASE_MAX_DEVICES,
    expiresAt: session.expiresAt.toISOString(),
  };
}

async function upsertPaidCustomer(name: string, email: string, phone: string | null, orderNo: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await prisma.customer.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
  });
  if (!existing) {
    return prisma.customer.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        phone,
        notes: `Website siparişi: ${orderNo}`,
      },
    });
  }
  return existing;
}

export async function consumeDesktopPurchaseToken(input: {
  purchaseToken?: unknown;
  tokenHash?: unknown;
  orderNo?: unknown;
  customerName?: unknown;
  customerEmail?: unknown;
  customerPhone?: unknown;
}) {
  const orderNo = typeof input.orderNo === 'string' ? input.orderNo.trim() : '';
  const customerName = typeof input.customerName === 'string' ? input.customerName.trim() : '';
  const customerEmail = typeof input.customerEmail === 'string' ? input.customerEmail.trim().toLowerCase() : '';
  const customerPhone = typeof input.customerPhone === 'string' ? input.customerPhone.trim() : null;
  if (!orderNo || !customerName || !customerEmail.includes('@')) {
    throw new DesktopPurchaseError('INVALID_REQUEST', 'Sipariş ve müşteri bilgisi zorunludur', 400);
  }

  let session = await findSessionByToken(input);
  if (session.appCode !== APP_CODE_BILIRKISI_DESKTOP || session.purpose !== DESKTOP_PURCHASE_PURPOSE) {
    throw new DesktopPurchaseError('PURCHASE_PRODUCT_MISMATCH', 'Bu bağlantı başka bir ürün için kullanılamaz', 400);
  }
  if (session.consumedAt && session.orderNo === orderNo && !session.paidLicenseId) {
    const resumed = await resumeUnfinishedConsume(session, orderNo, customerName, customerEmail, customerPhone);
    session = {
      ...session,
      paidLicenseId: resumed.paidLicenseId,
      consumedAt: resumed.consumedAt,
      orderNo: resumed.orderNo,
    };
  }
  if (session.consumedAt) {
    if (session.orderNo !== orderNo || !session.paidLicenseId) {
      throw new DesktopPurchaseError('PURCHASE_TOKEN_USED', 'Bu satın alma bağlantısı kullanılmış', 409);
    }
    const activationPassword = await regenerateActivationPassword(session.paidLicenseId);
    const license = await prisma.license.findUnique({ where: { id: session.paidLicenseId } });
    if (!license) {
      throw new DesktopPurchaseError('PURCHASE_TOKEN_USED', 'Bu satın alma bağlantısı kullanılmış', 409);
    }
    return {
      success: true as const,
      alreadyExists: true,
      orderNo,
      licenseKey: license.licenseKey,
      activationPassword,
      expiresAt: license.expiresAt.toISOString(),
      platform: session.platform,
      maxDevices: license.maxDevices,
    };
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw new DesktopPurchaseError('PURCHASE_TOKEN_EXPIRED', 'Satın alma bağlantısının süresi doldu', 410);
  }

  const claim = await prisma.desktopPurchaseSession.updateMany({
    where: { id: session.id, consumedAt: null, purpose: DESKTOP_PURCHASE_PURPOSE },
    data: { consumedAt: new Date(), orderNo },
  });
  if (claim.count !== 1) {
    throw new DesktopPurchaseError('PURCHASE_TOKEN_USED', 'Bu satın alma bağlantısı kullanılmış', 409);
  }

  try {
    const finished = await resumeUnfinishedConsume(
      { ...session, consumedAt: new Date(), orderNo, paidLicenseId: null },
      orderNo,
      customerName,
      customerEmail,
      customerPhone,
    );
    const license = await prisma.license.findUnique({ where: { id: finished.paidLicenseId! } });
    if (!license) throw new DesktopPurchaseError('PURCHASE_FAILED', 'Ücretli lisans oluşturulamadı', 500);
    const activationPassword = await regenerateActivationPassword(license.id);
    return {
      success: true as const,
      alreadyExists: false,
      orderNo,
      licenseKey: license.licenseKey,
      activationPassword,
      expiresAt: license.expiresAt.toISOString(),
      platform: session.platform,
      maxDevices: DESKTOP_PURCHASE_MAX_DEVICES,
    };
  } catch (err) {
    await prisma.desktopPurchaseSession.updateMany({
      where: { id: session.id, paidLicenseId: null, orderNo },
      data: { consumedAt: null, orderNo: null },
    });
    throw err;
  }
}

async function resumeUnfinishedConsume(
  session: {
    id: string;
    appCode: string;
    platform: string;
    deviceHash: string;
    paidLicenseId: string | null;
    consumedAt: Date | null;
    orderNo: string | null;
  },
  orderNo: string,
  customerName: string,
  customerEmail: string,
  customerPhone: string | null,
) {
  if (session.paidLicenseId) return session;
  const program = await prisma.program.findUnique({ where: { appCode: session.appCode } });
  if (!program) {
    throw new DesktopPurchaseError('PROGRAM_NOT_FOUND_OR_INACTIVE', 'Ürün bulunamadı', 404);
  }
  const note = orderNote(orderNo);
  let license = await prisma.license.findFirst({
    where: { notes: note, source: LicenseSource.WEBSITE_ORDER, programId: program.id },
  });
  if (!license) {
    const customer = await upsertPaidCustomer(customerName, customerEmail, customerPhone, orderNo);
    const created = await createLicense({
      customerId: customer.id,
      programId: program.id,
      source: LicenseSource.WEBSITE_ORDER,
      licenseDays: DESKTOP_PURCHASE_LICENSE_DAYS,
      maxDevices: DESKTOP_PURCHASE_MAX_DEVICES,
      notes: note,
      platform: session.platform,
      sendMail: false,
    });
    license = created.license;
  }
  await prisma.licenseDevice.upsert({
    where: { licenseId_deviceHash: { licenseId: license.id, deviceHash: session.deviceHash } },
    update: { status: 'ACTIVE', platform: session.platform },
    create: {
      licenseId: license.id,
      deviceHash: session.deviceHash,
      platform: session.platform,
      status: 'ACTIVE',
    },
  });
  return prisma.desktopPurchaseSession.update({
    where: { id: session.id },
    data: { paidLicenseId: license.id, orderNo, consumedAt: session.consumedAt ?? new Date() },
  });
}

export async function handoffPaidDesktopLicense(input: {
  appCode?: unknown;
  deviceHash?: unknown;
  platform?: unknown;
}) {
  const appCode = assertAppCode(input.appCode);
  const platform = assertPlatform(input.platform);
  const deviceHash = assertDeviceHash(input.deviceHash);
  const session = await prisma.desktopPurchaseSession.findFirst({
    where: {
      appCode,
      platform,
      deviceHash,
      purpose: DESKTOP_PURCHASE_PURPOSE,
      consumedAt: { not: null },
      paidLicenseId: { not: null },
    },
    orderBy: { consumedAt: 'desc' },
  });
  if (!session?.paidLicenseId) {
    throw new DesktopPurchaseError('PAID_LICENSE_NOT_READY', 'Ücretli lisans henüz hazır değil', 404);
  }
  const license = await prisma.license.findUnique({
    where: { id: session.paidLicenseId },
    include: { program: true },
  });
  if (
    !license ||
    license.program.appCode !== appCode ||
    license.platform !== platform ||
    license.maxDevices !== DESKTOP_PURCHASE_MAX_DEVICES ||
    isSystemTrialLicenseNotes(license.notes) ||
    license.status !== LicenseStatus.ACTIVE ||
    license.expiresAt.getTime() <= Date.now()
  ) {
    throw new DesktopPurchaseError('PAID_LICENSE_NOT_READY', 'Ücretli lisans henüz hazır değil', 404);
  }
  const device = await prisma.licenseDevice.findUnique({
    where: { licenseId_deviceHash: { licenseId: license.id, deviceHash } },
  });
  if (!device || device.status !== 'ACTIVE') {
    throw new DesktopPurchaseError('PAID_LICENSE_NOT_READY', 'Ücretli lisans henüz hazır değil', 404);
  }
  return {
    success: true as const,
    licenseKey: license.licenseKey,
    expiresAt: license.expiresAt.toISOString(),
    maxDevices: license.maxDevices,
    platform,
    appCode,
  };
}
