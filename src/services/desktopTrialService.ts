import { randomBytes } from 'crypto';
import {
  DesktopTrialStatus,
  LicenseSource,
  LicenseStatus,
  Prisma,
  ProgramProductType,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  APP_CODE_BILIRKISI_DESKTOP,
  AUTO_TRIAL_APP_CODES,
  DEVICE_HASH_SHA256_HEX,
  SYSTEM_TRIAL_NOTES_PREFIX,
  DEMO_EXPIRED_USER_MESSAGE,
  bilirkisiTrialExpiresAt,
  TRIAL_ERROR_CODES,
  getDesktopTrialProgramConfig,
  type DesktopTrialProgramConfig,
} from '../constants/desktopTrial';
import { normalizeDesktopEntitlementPlatform } from '../lib/desktopPlatform';
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
  /** Yalnız website entegrasyonu. Public route bu alanı siler. */
  reserveOnly?: unknown;
  /** Yalnız website entegrasyonu. Public route bu alanı siler. */
  trustedTrialDays?: unknown;
};

type NormalizedTrialInput = {
  appCode: string;
  deviceHash: string;
  deviceName?: string;
  platform?: string;
  platformScope: string;
  appVersion?: string;
};

type NormalizedTrialStartInput = NormalizedTrialInput & {
  emailNormalized: string;
  phoneNormalized: string | null;
  reserveOnly: boolean;
  trustedTrialDays: number | null;
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

function platformScopeFor(appCode: string, platformRaw: unknown): string {
  if (appCode !== APP_CODE_BILIRKISI_DESKTOP) return '';
  const platform = normalizeDesktopEntitlementPlatform(platformRaw);
  if (!platform) {
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.INVALID_PLATFORM,
      'Bilirkişi Desktop denemesi için platform WINDOWS veya MACOS olmalıdır',
      400
    );
  }
  return platform;
}

function readTrustedTrialDays(raw: unknown, enabled: boolean): number | null {
  if (!enabled || raw == null || raw === '') return null;
  const days = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.INVALID_REQUEST,
      'trialDays 1 ile 30 arasında tam sayı olmalıdır',
      400
    );
  }
  return days;
}

function normalizeValidateInput(input: TrialRequestInput): NormalizedTrialInput {
  const appCode = normalizeAppCode(input.appCode);
  return {
    appCode,
    deviceHash: normalizeDeviceHash(input.deviceHash),
    deviceName: optionalString(input.deviceName),
    platform: optionalString(input.platform),
    platformScope: platformScopeFor(appCode, input.platform),
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
  grant: { deviceHash: string; emailNormalized: string | null; phoneNormalized: string | null; deviceBound: boolean },
  input: NormalizedTrialStartInput
): boolean {
  return (
    grant.deviceBound &&
    grant.deviceHash === input.deviceHash &&
    grant.emailNormalized === input.emailNormalized &&
    grant.phoneNormalized === input.phoneNormalized
  );
}

function isUnboundSameEmail(
  grant: { emailNormalized: string | null; phoneNormalized: string | null; deviceBound: boolean },
  input: NormalizedTrialStartInput
): boolean {
  return (
    !grant.deviceBound &&
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
    input.reserveOnly
      ? Promise.resolve(null)
      : db.desktopTrialGrant.findUnique({
          where: {
            programId_platformScope_deviceHash: {
              programId,
              platformScope: input.platformScope,
              deviceHash: input.deviceHash,
            },
          },
        }),
    db.desktopTrialGrant.findUnique({
      where: {
        programId_platformScope_emailNormalized: {
          programId,
          platformScope: input.platformScope,
          emailNormalized: input.emailNormalized,
        },
      },
    }),
    input.phoneNormalized
      ? db.desktopTrialGrant.findUnique({
          where: {
            programId_platformScope_phoneNormalized: {
              programId,
              platformScope: input.platformScope,
              phoneNormalized: input.phoneNormalized,
            },
          },
        })
      : Promise.resolve(null),
  ]);

  const unique = new Map<string, NonNullable<typeof byDevice>>();
  for (const grant of [byDevice, byEmail, byPhone]) {
    if (grant) unique.set(grant.id, grant);
  }
  return [...unique.values()];
}

async function assertNoOtherPlatformDesktopTrial(
  db: Prisma.TransactionClient | typeof prisma,
  programId: string,
  input: NormalizedTrialStartInput,
  cfg: DesktopTrialProgramConfig,
) {
  if (input.appCode !== APP_CODE_BILIRKISI_DESKTOP) return;
  const other = await db.desktopTrialGrant.findFirst({
    where: {
      programId,
      NOT: { platformScope: input.platformScope },
      OR: [
        { emailNormalized: input.emailNormalized },
        ...(input.phoneNormalized ? [{ phoneNormalized: input.phoneNormalized }] : []),
      ],
    },
  });
  if (other) throw alreadyUsedError(cfg, other);
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
  grant: { id: string; status: DesktopTrialStatus; expiresAt: Date; platformScope?: string },
  resumed: boolean
) {
  const payload = {
    success: true,
    resumed,
    ...trialPublicPayload(cfg, {
      status: grant.status,
      expiresAt: grant.expiresAt,
      message: resumed ? 'Mevcut deneme lisansı devam ediyor' : '7 günlük deneme başlatıldı',
    }),
  };
  if (cfg.appCode !== APP_CODE_BILIRKISI_DESKTOP) return payload;
  return {
    ...payload,
    grantId: grant.id,
    platform: grant.platformScope || undefined,
    maxDevices: 1,
  };
}

type ExistingGrantAction = 'resume' | 'bind' | 'used';

function existingGrantAction(
  existing: {
    deviceHash: string;
    emailNormalized: string | null;
    phoneNormalized: string | null;
    deviceBound: boolean;
    status: DesktopTrialStatus;
    expiresAt: Date;
  },
  input: NormalizedTrialStartInput,
  now: Date
): ExistingGrantAction {
  if (!isActiveUnexpired(existing, now)) return 'used';
  if (isSameContactIdentity(existing, input)) return 'resume';
  if (isUnboundSameEmail(existing, input)) return input.reserveOnly ? 'resume' : 'bind';
  return 'used';
}

export async function startDesktopTrial(input: TrialRequestInput) {
  const appCode = normalizeAppCode(input.appCode);
  const reserveOnly = appCode === APP_CODE_BILIRKISI_DESKTOP && input.reserveOnly === true;
  const prelim: NormalizedTrialInput = {
    appCode,
    deviceHash: reserveOnly ? randomBytes(32).toString('hex') : normalizeDeviceHash(input.deviceHash),
    deviceName: optionalString(input.deviceName),
    platform: optionalString(input.platform),
    platformScope: platformScopeFor(appCode, input.platform),
    appVersion: optionalString(input.appVersion),
  };
  const phoneNormalized =
    prelim.appCode === APP_CODE_BILIRKISI_DESKTOP &&
    (input.phone == null || (typeof input.phone === 'string' && !input.phone.trim()))
      ? null
      : normalizeTrialPhoneOrThrow(input.phone);
  const normalized: NormalizedTrialStartInput = {
    ...prelim,
    emailNormalized: normalizeTrialEmailOrThrow(input.email),
    phoneNormalized,
    reserveOnly,
    trustedTrialDays: readTrustedTrialDays(input.trustedTrialDays, reserveOnly),
  };
  const program = await assertTrialProgram(prelim.appCode);
  const cfg = getDesktopTrialProgramConfig(program.appCode);
  if (!cfg) {
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.TRIAL_NOT_AVAILABLE_FOR_PRODUCT,
      'Bu ürün için otomatik deneme lisansı verilmez',
      400
    );
  }
  const now = new Date();

  const existingRelated = await findRelatedGrants(prisma, program.id, normalized);
  if (existingRelated.length === 1) {
    const existing = existingRelated[0];
    const action = existingGrantAction(existing, normalized, now);
    if (action === 'resume') return trialStartSuccess(cfg, existing, true);
    if (action !== 'bind') throw alreadyUsedError(cfg, existing);
  } else if (existingRelated.length > 1) {
    throw alreadyUsedError(cfg, existingRelated[0]);
  }

  await assertNoOtherPlatformDesktopTrial(prisma, program.id, normalized, cfg);

  const trialDays =
    normalized.appCode === APP_CODE_BILIRKISI_DESKTOP ? cfg.trialDays : (normalized.trustedTrialDays ?? cfg.trialDays);
  const expiresAt =
    normalized.appCode === APP_CODE_BILIRKISI_DESKTOP
      ? bilirkisiTrialExpiresAt(now)
      : computeTrialExpiry(now, trialDays);

  try {
    const result = await prisma.$transaction(async (tx) => {
      await assertNoOtherPlatformDesktopTrial(tx, program.id, normalized, cfg);
      const relatedInTx = await findRelatedGrants(tx, program.id, normalized);
      if (relatedInTx.length === 1) {
        const existing = relatedInTx[0];
        const action = existingGrantAction(existing, normalized, now);
        if (action === 'resume') return { grant: existing, created: false };
        if (action === 'bind') {
          const taken = await tx.desktopTrialGrant.findUnique({
            where: {
              programId_platformScope_deviceHash: {
                programId: program.id,
                platformScope: normalized.platformScope,
                deviceHash: normalized.deviceHash,
              },
            },
          });
          if (taken && taken.id !== existing.id) throw alreadyUsedError(cfg, taken);
          const grant = await tx.desktopTrialGrant.update({
            where: { id: existing.id },
            data: {
              deviceHash: normalized.deviceHash,
              deviceBound: true,
              deviceName: normalized.deviceName,
              platform: normalized.platformScope || normalized.platform,
              appVersion: normalized.appVersion,
            },
          });
          if (existing.licenseId) {
            await tx.licenseDevice.create({
              data: {
                licenseId: existing.licenseId,
                deviceHash: normalized.deviceHash,
                deviceName: normalized.deviceName,
                platform: normalized.platformScope || normalized.platform,
                appVersion: normalized.appVersion,
              },
            });
          }
          return { grant, created: false };
        }
        throw alreadyUsedError(cfg, existing);
      }
      if (relatedInTx.length > 1) {
        throw alreadyUsedError(cfg, relatedInTx[0]);
      }

      const createdGrant = await tx.desktopTrialGrant.create({
        data: {
          programId: program.id,
          platformScope: normalized.platformScope,
          deviceHash: normalized.deviceHash,
          deviceBound: !normalized.reserveOnly,
          deviceName: normalized.deviceName,
          platform: normalized.platformScope || normalized.platform,
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
          platform: normalized.platformScope || null,
        },
      });

      if (!normalized.reserveOnly) {
        await tx.licenseDevice.create({
          data: {
            licenseId: license.id,
            deviceHash: normalized.deviceHash,
            deviceName: normalized.deviceName,
            platform: normalized.platformScope || normalized.platform,
            appVersion: normalized.appVersion,
          },
        });
      }

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
      if (recovered.length === 1 && existingGrantAction(recovered[0], normalized, now) === 'resume') {
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
      programId_platformScope_deviceHash: {
        programId: program.id,
        platformScope: normalized.platformScope,
        deviceHash: normalized.deviceHash,
      },
    },
  });

  if (!grant || !grant.deviceBound) {
    if (normalized.appCode === APP_CODE_BILIRKISI_DESKTOP) {
      const otherPlatform = await prisma.desktopTrialGrant.findFirst({
        where: {
          programId: program.id,
          deviceHash: normalized.deviceHash,
          deviceBound: true,
          NOT: { platformScope: normalized.platformScope },
        },
      });
      if (otherPlatform) {
        throw new DesktopTrialError(
          TRIAL_ERROR_CODES.PLATFORM_MISMATCH,
          'Bu deneme lisansı bu işletim sisteminde kullanılamaz',
          400
        );
      }
    }
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
    const expiredMessage =
      cfg.appCode === APP_CODE_BILIRKISI_DESKTOP ? DEMO_EXPIRED_USER_MESSAGE : 'Deneme süresi dolmuş';
    throw new DesktopTrialError(
      TRIAL_ERROR_CODES.TRIAL_EXPIRED,
      expiredMessage,
      400,
      trialPublicPayload(cfg, {
        status: DesktopTrialStatus.EXPIRED,
        expiresAt: grant.expiresAt,
        message: expiredMessage,
      })
    );
  }

  await prisma.desktopTrialGrant.update({
    where: { id: grant.id },
    data: { lastValidatedAt: now },
  });

  const payload = trialPublicPayload(cfg, {
    status: DesktopTrialStatus.ACTIVE,
    expiresAt: grant.expiresAt,
    message: 'Deneme lisansı geçerli',
  });
  return {
    success: true,
    valid: true,
    ...payload,
    ...(cfg.appCode === APP_CODE_BILIRKISI_DESKTOP
      ? { platform: grant.platformScope, maxDevices: 1 }
      : {}),
  };
}
