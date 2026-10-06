/**
 * Local-only Bilirkişi Desktop trial checks.
 * Refuses production DATABASE_URL.
 */
import { createHash, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { assertLocalDatabaseUrl } from './assertLocalTestTarget';
import { APP_CODE_BILIRKISI_DESKTOP, TRIAL_ERROR_CODES } from '../src/constants/desktopTrial';
import { DesktopTrialError, startDesktopTrial, validateDesktopTrial } from '../src/services/desktopTrialService';
import { activateLicense, createLicense, validateLicense } from '../src/services/licenseService';

assertLocalDatabaseUrl();

const prisma = new PrismaClient();
let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
    failed++;
  }
}

function hash(label: string): string {
  return createHash('sha256').update(`${label}-${randomBytes(8).toString('hex')}`).digest('hex');
}

function daysUntil(iso: string): number {
  return (Date.parse(iso) - Date.now()) / (24 * 60 * 60 * 1000);
}

async function expectCode(fn: () => Promise<unknown>, code: string, name: string) {
  try {
    await fn();
    assert(false, name, 'no error');
  } catch (err) {
    const ok = err instanceof DesktopTrialError && err.code === code;
    assert(ok, name, err instanceof Error ? err.message : String(err));
  }
}

async function main() {
  console.log('\n=== Bilirkişi Desktop local trial ===\n');
  const program = await prisma.program.upsert({
    where: { appCode: APP_CODE_BILIRKISI_DESKTOP },
    update: { isActive: true, productType: 'DESKTOP', defaultLicenseDays: 365, defaultMaxDevices: 1 },
    create: {
      appCode: APP_CODE_BILIRKISI_DESKTOP,
      name: 'Bilirkişi Desktop',
      productType: 'DESKTOP',
      defaultLicenseDays: 365,
      defaultMaxDevices: 1,
    },
  });
  const mk = await prisma.program.upsert({
    where: { appCode: 'MUVEKKIL_KASA_DESKTOP' },
    update: { isActive: true, productType: 'DESKTOP' },
    create: {
      appCode: 'MUVEKKIL_KASA_DESKTOP',
      name: 'Müvekkil Kasa Defteri Desktop',
      productType: 'DESKTOP',
      defaultLicenseDays: 365,
      defaultMaxDevices: 1,
    },
  });

  const email = `bh-trial-${Date.now()}@example.com`;
  const windowsDevice = hash('win');
  const macosDevice = hash('mac');

  const reserved = await startDesktopTrial({
    appCode: APP_CODE_BILIRKISI_DESKTOP,
    email,
    platform: 'WINDOWS',
    reserveOnly: true,
    trustedTrialDays: 7,
  });
  assert(reserved.success === true, 'Windows reservation created');
  assert(reserved.platform === 'WINDOWS', 'reservation platform WINDOWS');
  assert(!('licenseKey' in reserved), 'reservation does not return licenseKey');
  assert(daysUntil(reserved.expiresAt) > 6.9 && daysUntil(reserved.expiresAt) < 7.1, 'expiresAt is 7 days');
  assert(reserved.offlineGraceDays === 0, 'trial offlineGraceDays is 0');

  const bound = await startDesktopTrial({
    appCode: APP_CODE_BILIRKISI_DESKTOP,
    email,
    platform: 'win32-x64',
    deviceHash: windowsDevice,
  });
  assert(bound.success === true, 'Windows device binds the reservation');

  const windowsOk = await validateDesktopTrial({
    appCode: APP_CODE_BILIRKISI_DESKTOP,
    deviceHash: windowsDevice,
    platform: 'WINDOWS',
  });
  assert(windowsOk.valid === true && windowsOk.offlineGraceDays === 0, 'Windows validate has no offline grace');

  await expectCode(
    () =>
      validateDesktopTrial({
        appCode: APP_CODE_BILIRKISI_DESKTOP,
        deviceHash: windowsDevice,
        platform: 'darwin',
      }),
    TRIAL_ERROR_CODES.PLATFORM_MISMATCH,
    'Windows trial rejects macOS validation'
  );

  await expectCode(
    () =>
      startDesktopTrial({
        appCode: APP_CODE_BILIRKISI_DESKTOP,
        email,
        platform: 'WINDOWS',
        deviceHash: hash('other-win'),
      }),
    TRIAL_ERROR_CODES.TRIAL_ALREADY_USED,
    'same email cannot start a second Windows trial'
  );

  await expectCode(
    () =>
      startDesktopTrial({
        appCode: APP_CODE_BILIRKISI_DESKTOP,
        email: `other-${email}`,
        platform: 'WINDOWS',
        deviceHash: windowsDevice,
      }),
    TRIAL_ERROR_CODES.TRIAL_ALREADY_USED,
    'same Windows device cannot start another trial'
  );

  const mac = await startDesktopTrial({
    appCode: APP_CODE_BILIRKISI_DESKTOP,
    email,
    platform: 'MACOS',
    deviceHash: macosDevice,
  });
  assert(mac.success === true && mac.platform === 'MACOS', 'Windows trial does not consume macOS trial');
  const macOk = await validateDesktopTrial({
    appCode: APP_CODE_BILIRKISI_DESKTOP,
    deviceHash: macosDevice,
    platform: 'darwin-arm64',
  });
  assert(macOk.valid === true, 'macOS device validates');
  await expectCode(
    () =>
      validateDesktopTrial({
        appCode: APP_CODE_BILIRKISI_DESKTOP,
        deviceHash: macosDevice,
        platform: 'win32',
      }),
    TRIAL_ERROR_CODES.PLATFORM_MISMATCH,
    'macOS trial rejects Windows validation'
  );

  const license = await prisma.license.findFirst({
    where: { programId: program.id, platform: 'WINDOWS', notes: { startsWith: 'SYSTEM_TRIAL:' } },
    orderBy: { createdAt: 'desc' },
  });
  assert(license?.maxDevices === 1, 'trial maxDevices is 1');
  assert(license?.platform === 'WINDOWS', 'trial license platform stored');

  const customer = await prisma.customer.create({
    data: { name: 'Local BH Paid Fixture', email: `bh-paid-${Date.now()}@example.com` },
  });
  const paid = await createLicense({
    customerId: customer.id,
    programId: program.id,
    licenseDays: 365,
    maxDevices: 1,
    platform: 'WINDOWS',
    notes: 'local test paid-shaped license',
  });
  const wrongOs = await activateLicense({
    licenseKey: paid.license.licenseKey,
    activationPassword: paid.activationPassword,
    appCode: APP_CODE_BILIRKISI_DESKTOP,
    deviceHash: hash('paid-wrong'),
    platform: 'darwin',
  });
  assert(wrongOs.success === false && wrongOs.code === 'PLATFORM_MISMATCH', 'paid-shaped Windows license rejects macOS');
  const rightOs = await activateLicense({
    licenseKey: paid.license.licenseKey,
    activationPassword: paid.activationPassword,
    appCode: APP_CODE_BILIRKISI_DESKTOP,
    deviceHash: hash('paid-right'),
    platform: 'win32',
  });
  assert(rightOs.success === true, 'paid-shaped Windows license activates on Windows');

  const mkCustomer = await prisma.customer.create({
    data: { name: 'Local MK Fixture', email: `mk-local-${Date.now()}@example.com` },
  });
  const mkLicense = await createLicense({
    customerId: mkCustomer.id,
    programId: mk.id,
    licenseDays: 365,
    maxDevices: 1,
    notes: 'local MK regression',
  });
  assert(mkLicense.license.platform == null, 'Müvekkil Kasa license platform stays null');
  const mkDevice = hash('mk');
  const mkActivate = await activateLicense({
    licenseKey: mkLicense.license.licenseKey,
    activationPassword: mkLicense.activationPassword,
    appCode: 'MUVEKKIL_KASA_DESKTOP',
    deviceHash: mkDevice,
    platform: 'win32-x64',
  });
  assert(mkActivate.success === true, 'Müvekkil Kasa activate still succeeds without a platform entitlement');
  const mkValidate = await validateLicense({
    licenseKey: mkLicense.license.licenseKey,
    appCode: 'MUVEKKIL_KASA_DESKTOP',
    deviceHash: mkDevice,
  });
  assert(mkValidate.valid === true && mkValidate.offlineGraceDays === 7, 'Müvekkil Kasa paid offline grace stays 7');

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
