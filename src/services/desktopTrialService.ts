import {
  DesktopTrialStatus,
  LicenseSource,
  LicenseStatus,
  Prisma,
  ProgramProductType,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  AUTO_TRIAL_APP_CODES,
  DEVICE_HASH_SHA256_HEX,
  SYSTEM_TRIAL_NOTES_PREFIX,
  TRIAL_ERROR_CODES,
  getDesktopTrialProgramConfig,
  type DesktopTrialProgramConfig,
} from '../constants/desktopTrial';
import { normalizeTrialEmail, normalizeTurkishMobile } from '../lib/trialContact';
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
  email?: unknown;
  phone?: unknown;
};

type NormalizedTrialInput = {
  appCode: string;
  deviceHash: string;
  deviceName?: string;
  platform?: string;
  appVersion?: string;
};

type NormalizedTrialStartInput = NormalizedTrialInput & {
  emailNormalized: string;
  phoneNormalized: string;
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

function normalizeTrialEmailOrThrow(raw: unknown): string {
  const email = normalizeTrialEmail(raw);
  if (!email) {
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.INVALID_EMAIL,
      'Geçerli bir e-posta adresi girin',
      400
    );
  }
  return email;
}

function normalizeTrialPhoneOrThrow(raw: unknown): string {
  const phone = normalizeTurkishMobile(raw);
  if (!phone) {
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.INVALID_PHONE,
      'Geçerli bir Türkiye cep telefonu girin',
      400
    );
  }
  return phone;
}

function normalizeValidateInput(input: TrialRequestInput): NormalizedTrialInput {
  return {
    appCode: normalizeAppCode(input.appCode),
    deviceHash: normalizeDeviceHash(input.deviceHash),
    deviceName: optionalString(input.deviceName),
    platform: optionalString(input.platform),
    appVersion: optionalString(input.appVersion),
  };
}

function computeTrialExpiry(from: Date, days: number): Date {
  const expiresAt = new Date(from);
  expiresAt.setDate(expiresAt.getDate() + days);
  return expiresAt;
}

function isP2002(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function alreadyUsedError(
  cfg: DesktopTrialProgramConfig,
  existing?: { status: DesktopTrialStatus; expiresAt: Date }
) {
  return new DesktopTrialError(
    TRIAL_ERROR_CODES.TRIAL_ALREADY_USED,
    cfg.alreadyUsedMessage,
    400,
    existing
      ? trialPublicPayload(cfg, {
          status: existing.status,
          expiresAt: existing.expiresAt,
          message: cfg.alreadyUsedMessage,
        })
      : { message: cfg.alreadyUsedMessage }
  );
}

function isSameContactIdentity(
  grant: { deviceHash: string; emailNormalized: string | null; phoneNormalized: string | null },
  input: NormalizedTrialStartInput
): boolean {
  return (
    grant.deviceHash === input.deviceHash &&
    grant.emailNormalized === input.emailNormalized &&
    grant.phoneNormalized === input.phoneNormalized
  );
}

function isActiveUnexpired(
  grant: { status: DesktopTrialStatus; expiresAt: Date },
  now: Date
): boolean {
  return grant.status === DesktopTrialStatus.ACTIVE && now <= grant.expiresAt;
}

async function findRelatedGrants(
  db: Prisma.TransactionClient | typeof prisma,
  programId: string,
  input: NormalizedTrialStartInput
) {
  const [byDevice, byEmail, byPhone] = await Promise.all([
    db.desktopTrialGrant.findUnique({
      where: {
        programId_deviceHash: {
          programId,
          deviceHash: input.deviceHash,
        },
      },
    }),
    db.desktopTrialGrant.findUnique({
      where: {
        programId_emailNormalized: {
          programId,
          emailNormalized: input.emailNormalized,
        },
      },
    }),
    db.desktopTrialGrant.findUnique({
      where: {
        programId_phoneNormalized: {
          programId,
          phoneNormalized: input.phoneNormalized,
        },
      },
    }),
  ]);

  const unique = new Map<string, NonNullable<typeof byDevice>>();
  for (const grant of [byDevice, byEmail, byPhone]) {
    if (grant) unique.set(grant.id, grant);
  }
  return [...unique.values()];
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

async function ensureSystemTrialCustomer(
  tx: Prisma.TransactionClient,
  cfg: DesktopTrialProgramConfig
) {
  // Customer.email unique değil; concurrent trial'lar duplicate SYSTEM müşteri açmasın.
  // KoopPlus lock key 712409 birebir korunur.
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${Number(cfg.advisoryLockKey)}, 1)`);
  const existing = await tx.customer.findFirst({
    where: { email: cfg.systemCustomerEmail },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) return existing;

  return tx.customer.create({
    data: {
      name: cfg.systemCustomerName,
      email: cfg.systemCustomerEmail,
      companyName: 'Woontegra System',
      notes: cfg.systemCustomerNotes,
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

function trialPublicPayload(
  cfg: DesktopTrialProgramConfig,
  input: {
    status: DesktopTrialStatus | 'ACTIVE' | 'EXPIRED';
    expiresAt: Date;
    message: string;
  }
) {
  const expiresAt = input.expiresAt.toISOString();
  return {
    trial: true as const,
    appCode: cfg.appCode,
    status: input.status,
    expiresAt,
    trialExpiresAt: expiresAt,
    offlineGraceDays: cfg.offlineGraceDays,
    message: input.message,
  };
}

function trialStartSuccess(
  cfg: DesktopTrialProgramConfig,
  grant: { status: DesktopTrialStatus; expiresAt: Date },
  resumed: boolean
) {
  return {
    success: true,
    resumed,
    ...trialPublicPayload(cfg, {
      status: grant.status,
      expiresAt: grant.expiresAt,
      message: resumed ? 'Mevcut deneme lisansı devam ediyor' : '7 günlük deneme başlatıldı',
    }),
  };
}

export async function startDesktopTrial(input: TrialRequestInput) {
  const prelim = normalizeValidateInput(input);
  const program = await assertTrialProgram(prelim.appCode);
  const cfg = getDesktopTrialProgramConfig(program.appCode);
  if (!cfg) {
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.TRIAL_NOT_AVAILABLE_FOR_PRODUCT,
      'Bu ürün için otomatik deneme lisansı verilmez',
      400
    );
  }
  const normalized: NormalizedTrialStartInput = {
    ...prelim,
    emailNormalized: normalizeTrialEmailOrThrow(input.email),
    phoneNormalized: normalizeTrialPhoneOrThrow(input.phone),
  };
  const now = new Date();

  const existingRelated = await findRelatedGrants(prisma, program.id, normalized);
  if (existingRelated.length === 1) {
    const existing = existingRelated[0];
    if (isSameContactIdentity(existing, normalized) && isActiveUnexpired(existing, now)) {
      return trialStartSuccess(cfg, existing, true);
    }
    throw alreadyUsedError(cfg, existing);
  }
  if (existingRelated.length > 1) {
    throw alreadyUsedError(cfg, existingRelated[0]);
  }

  const expiresAt = computeTrialExpiry(now, cfg.trialDays);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const relatedInTx = await findRelatedGrants(tx, program.id, normalized);
      if (relatedInTx.length === 1) {
        const existing = relatedInTx[0];
        if (isSameContactIdentity(existing, normalized) && isActiveUnexpired(existing, now)) {
          return { grant: existing, created: false };
        }
        throw alreadyUsedError(cfg, existing);
      }
      if (relatedInTx.length > 1) {
        throw alreadyUsedError(cfg, relatedInTx[0]);
      }

      const createdGrant = await tx.desktopTrialGrant.create({
        data: {
          programId: program.id,
          deviceHash: normalized.deviceHash,
          deviceName: normalized.deviceName,
          platform: normalized.platform,
          appVersion: normalized.appVersion,
          emailNormalized: normalized.emailNormalized,
          phoneNormalized: normalized.phoneNormalized,
          status: DesktopTrialStatus.ACTIVE,
          expiresAt,
        },
      });

      const customer = await ensureSystemTrialCustomer(tx, cfg);
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
          notes: `${SYSTEM_TRIAL_NOTES_PREFIX}${cfg.appCode}`,
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
          message: `Otomatik trial: ${cfg.appCode}`,
        },
      });

      const grant = await tx.desktopTrialGrant.update({
        where: { id: createdGrant.id },
        data: { licenseId: license.id },
      });
      return { grant, created: true };
    });

    return trialStartSuccess(cfg, result.grant, !result.created);
  } catch (err) {
    if (err instanceof DesktopTrialError) throw err;
    if (isP2002(err)) {
      const recovered = await findRelatedGrants(prisma, program.id, normalized);
      if (
        recovered.length === 1 &&
        isSameContactIdentity(recovered[0], normalized) &&
        isActiveUnexpired(recovered[0], now)
      ) {
        return trialStartSuccess(cfg, recovered[0], true);
      }
      throw alreadyUsedError(cfg, recovered[0]);
    }
    throw err;
  }
}

export async function validateDesktopTrial(input: TrialRequestInput) {
  const normalized = normalizeValidateInput(input);
  const program = await assertTrialProgram(normalized.appCode);
  const cfg = getDesktopTrialProgramConfig(program.appCode);
  if (!cfg) {
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.TRIAL_NOT_AVAILABLE_FOR_PRODUCT,
      'Bu ürün için otomatik deneme lisansı verilmez',
      400
    );
  }

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
      trialPublicPayload(cfg, {
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
    ...trialPublicPayload(cfg, {
      status: DesktopTrialStatus.ACTIVE,
      expiresAt: grant.expiresAt,
      message: 'Deneme lisansı geçerli',
    }),
  };
}
