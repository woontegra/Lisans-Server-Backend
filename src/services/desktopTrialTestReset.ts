import { DesktopTrialStatus, DeviceStatus, LicenseEventType, LicenseStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  TEST_TRIAL_RESET_MARKER,
  getDesktopTrialTestIdentity,
  isSystemTrialLicenseNotes,
} from '../constants/desktopTrial';

export class DesktopTrialTestResetError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number = 400
  ) {
    super(message);
    this.name = 'DesktopTrialTestResetError';
  }
}

export type DesktopTrialTestResetInput = {
  appCode: unknown;
  adminEmail: string;
  ipAddress?: string;
  dryRun?: boolean;
};

type GrantRow = {
  id: string;
  deviceHash: string;
  emailNormalized: string | null;
  phoneNormalized: string | null;
  licenseId: string | null;
  status: DesktopTrialStatus;
  expiresAt: Date;
};

/**
 * Yalnız e-postası VE telefonu test kimliğiyle birebir eşleşen demo kayıtları test kaydıdır.
 * Tek alanı eşleşen kayıtlar başka birine ait olabilir; dokunulmaz, raporlanır.
 */
async function findTestIdentityGrants(
  db: Pick<typeof prisma, 'desktopTrialGrant'>,
  programId: string,
  identity: { emailNormalized: string; phoneNormalized: string }
) {
  const rows: GrantRow[] = await db.desktopTrialGrant.findMany({
    where: {
      programId,
      platformScope: '',
      OR: [
        { emailNormalized: identity.emailNormalized },
        { phoneNormalized: identity.phoneNormalized },
      ],
    },
    select: {
      id: true,
      deviceHash: true,
      emailNormalized: true,
      phoneNormalized: true,
      licenseId: true,
      status: true,
      expiresAt: true,
    },
  });
  const testGrants = rows.filter(
    (g) =>
      g.emailNormalized === identity.emailNormalized &&
      g.phoneNormalized === identity.phoneNormalized
  );
  const conflicts = rows
    .filter((g) => !testGrants.includes(g))
    .map((g) => ({
      grantId: g.id,
      matchedOn: g.emailNormalized === identity.emailNormalized ? 'email' : 'phone',
    }));
  return { testGrants, conflicts };
}

export async function resetDesktopTrialTestIdentity(input: DesktopTrialTestResetInput) {
  const appCode = typeof input.appCode === 'string' ? input.appCode.trim().toUpperCase() : '';
  const identity = getDesktopTrialTestIdentity(appCode);
  if (!identity) {
    throw new DesktopTrialTestResetError(
      'TEST_RESET_NOT_ALLOWED',
      'Bu ürün için demo test sıfırlaması tanımlı değil'
    );
  }
  const program = await prisma.program.findUnique({ where: { appCode } });
  if (!program) {
    throw new DesktopTrialTestResetError('PROGRAM_NOT_FOUND', 'Program bulunamadı', 404);
  }

  if (input.dryRun) {
    const { testGrants, conflicts } = await findTestIdentityGrants(prisma, program.id, identity);
    return {
      dryRun: true,
      appCode,
      resetCount: 0,
      wouldResetGrantIds: testGrants.map((g) => g.id),
      conflicts,
    };
  }

  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const { testGrants, conflicts } = await findTestIdentityGrants(tx, program.id, identity);

    for (const grant of testGrants) {
      const license = grant.licenseId
        ? await tx.license.findUnique({
            where: { id: grant.licenseId },
            select: { id: true, programId: true, notes: true, expiresAt: true },
          })
        : null;
      if (license && (license.programId !== program.id || !isSystemTrialLicenseNotes(license.notes))) {
        throw new DesktopTrialTestResetError(
          'TEST_RESET_UNSAFE_LICENSE',
          `Demo kaydı ${grant.id} sistem deneme lisansına bağlı değil; sıfırlama iptal edildi`,
          409
        );
      }

      const audit =
        `${TEST_TRIAL_RESET_MARKER} ${now.toISOString()} admin=${input.adminEmail}` +
        ` grant=${grant.id} device=${grant.deviceHash}` +
        ` email=${grant.emailNormalized} phone=${grant.phoneNormalized}` +
        ` previousStatus=${grant.status} previousExpiresAt=${grant.expiresAt.toISOString()}`;

      await tx.desktopTrialGrant.update({
        where: { id: grant.id },
        data: {
          status: DesktopTrialStatus.EXPIRED,
          expiresAt: grant.expiresAt < now ? grant.expiresAt : now,
          deviceHash: `${TEST_TRIAL_RESET_MARKER}:${grant.id}`,
          emailNormalized: null,
          phoneNormalized: null,
        },
      });

      if (license) {
        await tx.license.update({
          where: { id: license.id },
          data: {
            status: LicenseStatus.PASSIVE,
            expiresAt: license.expiresAt < now ? license.expiresAt : now,
            notes: `${license.notes} | ${TEST_TRIAL_RESET_MARKER} ${now.toISOString()} admin=${input.adminEmail}`,
          },
        });
        await tx.licenseDevice.updateMany({
          where: { licenseId: license.id },
          data: { status: DeviceStatus.REVOKED },
        });
        await tx.licenseEvent.create({
          data: {
            licenseId: license.id,
            eventType: LicenseEventType.LICENSE_DISABLED,
            message: audit,
            ipAddress: input.ipAddress,
          },
        });
      } else {
        console.warn(`[desktop-trial-test-reset] ${audit} (bağlı lisans yok)`);
      }
    }

    return { resetGrantIds: testGrants.map((g) => g.id), conflicts };
  });

  console.info(
    `[desktop-trial-test-reset] appCode=${appCode} admin=${input.adminEmail} reset=${result.resetGrantIds.length} conflicts=${result.conflicts.length}`
  );
  return {
    dryRun: false,
    appCode,
    resetCount: result.resetGrantIds.length,
    resetGrantIds: result.resetGrantIds,
    conflicts: result.conflicts,
  };
}
