import {
  DesktopTrialStatus,
  LicenseSource,
  LicenseStatus,
  Prisma,
  ProgramProductType,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  APP_CODE_KOOPPLUS_DESKTOP,
  AUTO_TRIAL_APP_CODES,
  DESKTOP_TRIAL_DAYS,
  DESKTOP_TRIAL_OFFLINE_GRACE_DAYS,
  DEVICE_HASH_SHA256_HEX,
  SYSTEM_TRIAL_CUSTOMER_EMAIL,
  SYSTEM_TRIAL_CUSTOMER_NAME,
  SYSTEM_TRIAL_CUSTOMER_NOTES,
  SYSTEM_TRIAL_NOTES_PREFIX,
  TRIAL_ERROR_CODES,
} from '../constants/desktopTrial';
import { generateActivationPassword, generateLicenseKey } from '../utils/licenseKey';
import { hashPassword } from '../utils/password';

export class DesktopTrialError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number = 400,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'DesktopTrialError';
  }
}

export type TrialRequestInput = {
  appCode?: unknown;
  deviceHash?: unknown;
  deviceName?: unknown;
  platform?: unknown;
  appVersion?: unknown;
};

type NormalizedTrialInput = {
  appCode: string;
  deviceHash: string;
  deviceName?: string;
  platform?: string;
  appVersion?: string;
};

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 200) : undefined;
}

function normalizeAppCode(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.INVALID_REQUEST,
      'appCode zorunludur',
      400
    );
  }
  return raw.trim().toUpperCase();
}

function normalizeDeviceHash(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.INVALID_DEVICE_HASH,
      'deviceHash zorunludur',
      400
    );
  }
  const hash = raw.trim().toLowerCase();
  if (!DEVICE_HASH_SHA256_HEX.test(hash)) {
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.INVALID_DEVICE_HASH,
      'deviceHash SHA-256 hex (64 karakter) olmalıdır',
      400
    );
  }
  return hash;
}

function normalizeInput(input: TrialRequestInput): NormalizedTrialInput {
  return {
    appCode: normalizeAppCode(input.appCode),
    deviceHash: normalizeDeviceHash(input.deviceHash),
    deviceName: optionalString(input.deviceName),
    platform: optionalString(input.platform),
    appVersion: optionalString(input.appVersion),
  };
}

function computeTrialExpiry(from: Date): Date {
  const expiresAt = new Date(from);
  expiresAt.setDate(expiresAt.getDate() + DESKTOP_TRIAL_DAYS);
  return expiresAt;
}

function isP2002(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function assertTrialProgram(appCode: string) {
  if (!AUTO_TRIAL_APP_CODES.has(appCode)) {
    const existing = await prisma.program.findUnique({ where: { appCode } });
    if (!existing) {
      throw new DesktopTrialError(
        TRIAL_ERROR_CODES.PROGRAM_NOT_FOUND_OR_INACTIVE,
        'Program bulunamadı veya aktif değil',
        400
      );
    }
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.TRIAL_NOT_AVAILABLE_FOR_PRODUCT,
      'Bu ürün için otomatik deneme lisansı verilmez',
      400
    );
  }

  const program = await prisma.program.findUnique({ where: { appCode } });
  if (!program || !program.isActive || program.productType !== ProgramProductType.DESKTOP) {
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.PROGRAM_NOT_FOUND_OR_INACTIVE,
      'Program bulunamadı veya aktif değil',
      400
    );
  }
  return program;
}

async function ensureSystemTrialCustomer(tx: Prisma.TransactionClient) {
  // Customer.email unique değil; concurrent trial'lar duplicate SYSTEM müşteri açmasın.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(712409, 1)`;
  const existing = await tx.customer.findFirst({
    where: { email: SYSTEM_TRIAL_CUSTOMER_EMAIL },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) return existing;

  return tx.customer.create({
    data: {
      name: SYSTEM_TRIAL_CUSTOMER_NAME,
      email: SYSTEM_TRIAL_CUSTOMER_EMAIL,
      companyName: 'Woontegra System',
      notes: SYSTEM_TRIAL_CUSTOMER_NOTES,
    },
  });
}

async function createUniqueTrialLicenseKey(tx: Prisma.TransactionClient): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const key = generateLicenseKey();
    const existing = await tx.license.findUnique({ where: { licenseKey: key } });
    if (!existing) return key;
  }
  throw new Error('Lisans anahtarı üretilemedi');
}

function trialPublicPayload(input: {
  status: DesktopTrialStatus | 'ACTIVE' | 'EXPIRED';
  expiresAt: Date;
  message: string;
}) {
  const expiresAt = input.expiresAt.toISOString();
  return {
    trial: true as const,
    appCode: APP_CODE_KOOPPLUS_DESKTOP,
    status: input.status,
    expiresAt,
    trialExpiresAt: expiresAt,
    offlineGraceDays: DESKTOP_TRIAL_OFFLINE_GRACE_DAYS,
    message: input.message,
  };
}

export async function startDesktopTrial(input: TrialRequestInput) {
  const normalized = normalizeInput(input);
  const program = await assertTrialProgram(normalized.appCode);

  const existing = await prisma.desktopTrialGrant.findUnique({
    where: {
      programId_deviceHash: {
        programId: program.id,
        deviceHash: normalized.deviceHash,
      },
    },
  });
  if (existing) {
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.TRIAL_ALREADY_USED,
      'Bu cihaz için deneme süresi daha önce kullanıldı',
      400,
      trialPublicPayload({
        status: existing.status,
        expiresAt: existing.expiresAt,
        message: 'Bu cihaz için deneme süresi daha önce kullanıldı',
      })
    );
  }

  const now = new Date();
  const expiresAt = computeTrialExpiry(now);

  try {
    const grant = await prisma.$transaction(async (tx) => {
      const createdGrant = await tx.desktopTrialGrant.create({
        data: {
          programId: program.id,
          deviceHash: normalized.deviceHash,
          deviceName: normalized.deviceName,
          platform: normalized.platform,
          appVersion: normalized.appVersion,
          status: DesktopTrialStatus.ACTIVE,
          expiresAt,
        },
      });

      const customer = await ensureSystemTrialCustomer(tx);
      const licenseKey = await createUniqueTrialLicenseKey(tx);
      const activationPasswordHash = await hashPassword(generateActivationPassword());

      const license = await tx.license.create({
        data: {
          licenseKey,
          activationPasswordHash,
          customerId: customer.id,
          programId: program.id,
          source: LicenseSource.API,
          startsAt: now,
          expiresAt,
          maxDevices: 1,
          status: LicenseStatus.ACTIVE,
          notes: `${SYSTEM_TRIAL_NOTES_PREFIX}${APP_CODE_KOOPPLUS_DESKTOP}`,
        },
      });

      await tx.licenseDevice.create({
        data: {
          licenseId: license.id,
          deviceHash: normalized.deviceHash,
          deviceName: normalized.deviceName,
          platform: normalized.platform,
          appVersion: normalized.appVersion,
        },
      });

      await tx.licenseEvent.create({
        data: {
          licenseId: license.id,
          eventType: 'LICENSE_CREATED',
          message: `Otomatik trial: ${APP_CODE_KOOPPLUS_DESKTOP}`,
        },
      });

      return tx.desktopTrialGrant.update({
        where: { id: createdGrant.id },
        data: { licenseId: license.id },
      });
    });

    return {
      success: true,
      ...trialPublicPayload({
        status: grant.status,
        expiresAt: grant.expiresAt,
        message: '7 günlük deneme başlatıldı',
      }),
    };
  } catch (err) {
    if (isP2002(err)) {
      throw new DesktopTrialError(
        TRIAL_ERROR_CODES.TRIAL_ALREADY_USED,
        'Bu cihaz için deneme süresi daha önce kullanıldı',
        400
      );
    }
    throw err;
  }
}

export async function validateDesktopTrial(input: TrialRequestInput) {
  const normalized = normalizeInput(input);
  const program = await assertTrialProgram(normalized.appCode);

  const grant = await prisma.desktopTrialGrant.findUnique({
    where: {
      programId_deviceHash: {
        programId: program.id,
        deviceHash: normalized.deviceHash,
      },
    },
  });

  if (!grant) {
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.TRIAL_NOT_FOUND,
      'Bu cihaz için deneme kaydı bulunamadı',
      400
    );
  }

  const now = new Date();
  if (now > grant.expiresAt) {
    if (grant.status !== DesktopTrialStatus.EXPIRED) {
      await prisma.desktopTrialGrant.update({
        where: { id: grant.id },
        data: { status: DesktopTrialStatus.EXPIRED },
      });
    }
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.TRIAL_EXPIRED,
      'Deneme süresi dolmuş',
      400,
      trialPublicPayload({
        status: DesktopTrialStatus.EXPIRED,
        expiresAt: grant.expiresAt,
        message: 'Deneme süresi dolmuş',
      })
    );
  }

  await prisma.desktopTrialGrant.update({
    where: { id: grant.id },
    data: { lastValidatedAt: now },
  });

  return {
    success: true,
    valid: true,
    ...trialPublicPayload({
      status: DesktopTrialStatus.ACTIVE,
      expiresAt: grant.expiresAt,
      message: 'Deneme lisansı geçerli',
    }),
  };
}
