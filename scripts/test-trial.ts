/**
 * KoopPlus desktop trial + mevcut activate/validate regression.
 * Yalnız lokal DATABASE_URL ile çalıştır.
 *
 * Kullanım (kök .env lokal postgres):
 *   $env:DATABASE_URL = (kök .env'den)
 *   npx tsx scripts/test-trial.ts
 */
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import app from '../src/app';
import {
  APP_CODE_KOOPPLUS_DESKTOP,
  DESKTOP_TRIAL_DAYS,
  DESKTOP_TRIAL_OFFLINE_GRACE_DAYS,
  KOOPPLUS_PROGRAM_DEFAULTS,
  SYSTEM_TRIAL_CUSTOMER_EMAIL,
  SYSTEM_TRIAL_NOTES_PREFIX,
  TRIAL_ERROR_CODES,
} from '../src/constants/desktopTrial';
import { hashPassword } from '../src/utils/password';
import { assertLocalDatabaseUrl } from './assertLocalTestTarget';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@woontegra.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-strong-password';

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
let BASE = '';

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
    failed++;
  }
}

function assertLocalDatabase() {
  assertLocalDatabaseUrl();
}

async function ensureAdminAndDesktopPrograms() {
  const email = ADMIN_EMAIL;
  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  const existingAdmin = await prisma.admin.findUnique({ where: { email } });
  if (!existingAdmin) {
    await prisma.admin.create({
      data: { email, passwordHash, name: 'Test Admin' },
    });
  }

  const desktopPrograms = [
    { appCode: 'MUVEKKIL_KASA_DESKTOP', name: 'Müvekkil Kasa Defteri Desktop' },
    { appCode: 'SIFRE_KASASI_DESKTOP', name: 'Şifre Kasası Desktop' },
    { appCode: 'ISLETME_DEFTERI_DESKTOP', name: 'İşletme Defteri Desktop' },
    { appCode: 'OPTIK_DESKTOP', name: 'Optik Programı Desktop' },
    { appCode: 'BILIRKISI_DESKTOP', name: 'Bilirkişi Desktop' },
  ];
  for (const program of desktopPrograms) {
    await prisma.program.upsert({
      where: { appCode: program.appCode },
      update: {},
      create: {
        appCode: program.appCode,
        name: program.name,
        productType: 'DESKTOP',
        defaultLicenseDays: 365,
        defaultMaxDevices: 1,
        isActive: true,
      },
    });
  }
}

async function json(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function sha256Hex(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function daysFromNow(iso: string): number {
  return (new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
}

const stamp = Date.now();

function uniqueEmail(tag: string): string {
  return `trial-${tag}-${stamp}@example.com`;
}

function uniqueMobile(offset: number): string {
  const nine = String(100000000 + (stamp % 80000000) + offset).slice(-9);
  return `+905${nine}`;
}

function trialReq(
  deviceHash: string,
  email: string,
  phone: string,
  extra: Record<string, unknown> = {}
) {
  return {
    appCode: APP_CODE_KOOPPLUS_DESKTOP,
    deviceHash,
    deviceName: 'Test PC',
    platform: 'win32',
    appVersion: '1.0.0',
    email,
    phone,
    ...extra,
  };
}

async function main() {
  console.log('\n=== KoopPlus desktop trial tests ===\n');
  assertLocalDatabase();
  await ensureAdminAndDesktopPrograms();

  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  BASE = `http://127.0.0.1:${port}`;

  const login = await json('POST', '/api/admin/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  assert(login.status === 200 && !!login.data.token, 'Admin login');
  const auth = { Authorization: `Bearer ${login.data.token}` };

  let programs = await json('GET', '/api/admin/programs', undefined, auth);
  let koop = (programs.data as { id: string; appCode: string }[]).find(
    (p) => p.appCode === APP_CODE_KOOPPLUS_DESKTOP
  );
  if (!koop) {
    const created = await json(
      'POST',
      '/api/admin/programs',
      {
        appCode: KOOPPLUS_PROGRAM_DEFAULTS.appCode,
        name: KOOPPLUS_PROGRAM_DEFAULTS.name,
        description: KOOPPLUS_PROGRAM_DEFAULTS.description,
        productType: 'DESKTOP',
        defaultLicenseDays: KOOPPLUS_PROGRAM_DEFAULTS.defaultLicenseDays,
        defaultMaxDevices: KOOPPLUS_PROGRAM_DEFAULTS.defaultMaxDevices,
        isActive: true,
      },
      auth
    );
    assert(created.status === 201, 'Create KOOPPLUS_DESKTOP via admin programs');
    assert(created.data.appCode === APP_CODE_KOOPPLUS_DESKTOP, 'Created appCode');
    assert(created.data.defaultLicenseDays === 365, 'defaultLicenseDays 365');
    assert(created.data.defaultMaxDevices === 1, 'defaultMaxDevices 1');
    koop = created.data;
  } else {
    assert(true, 'KOOPPLUS_DESKTOP already present via admin programs');
  }

  programs = await json('GET', '/api/admin/programs', undefined, auth);
  const mkd = (programs.data as { id: string; appCode: string }[]).find(
    (p) => p.appCode === 'MUVEKKIL_KASA_DESKTOP'
  );
  assert(!!mkd, 'MUVEKKIL_KASA_DESKTOP still exists');

  const deviceA = sha256Hex(`koopplus-trial-a-${Date.now()}-${Math.random()}`);
  const deviceB = sha256Hex(`koopplus-trial-b-${Date.now()}-${Math.random()}`);
  const deviceC = sha256Hex(`koopplus-trial-c-${Date.now()}-${Math.random()}`);
  const deviceD = sha256Hex(`koopplus-trial-d-${Date.now()}-${Math.random()}`);
  const deviceE = sha256Hex(`koopplus-trial-e-${Date.now()}-${Math.random()}`);
  const deviceF = sha256Hex(`koopplus-trial-f-${Date.now()}-${Math.random()}`);
  const deviceG = sha256Hex(`koopplus-trial-g-${Date.now()}-${Math.random()}`);
  const deviceH = sha256Hex(`koopplus-trial-h-${Date.now()}-${Math.random()}`);
  const raceDevice = sha256Hex(`koopplus-trial-race-${Date.now()}-${Math.random()}`);
  const expiredDevice = sha256Hex(`koopplus-trial-expired-${Date.now()}-${Math.random()}`);
  const legacyDevice = sha256Hex(`koopplus-trial-legacy-${Date.now()}-${Math.random()}`);

  const emailA = uniqueEmail('a');
  const emailB = uniqueEmail('b');
  const emailC = uniqueEmail('c');
  const emailD = uniqueEmail('d');
  const emailE = uniqueEmail('e');
  const emailF = uniqueEmail('f');
  const emailG = uniqueEmail('g');
  const emailH = uniqueEmail('h');
  const phoneA = uniqueMobile(1);
  const phoneB = uniqueMobile(2);
  const phoneC = uniqueMobile(3);
  const phoneD = uniqueMobile(4);
  const phoneE = uniqueMobile(5);
  const phoneF = uniqueMobile(6);
  const phoneG = uniqueMobile(7);
  const phoneH = uniqueMobile(8);
  const phoneRace = uniqueMobile(9);
  const emailRace = uniqueEmail('race');

  const trialBody = trialReq(deviceA, emailA, phoneA);

  const first = await json('POST', '/api/public/license/trial', trialBody);
  assert(first.status === 201 && first.data.success === true, '1) new device+email+phone gets 7-day trial');
  assert(first.data.trial === true, 'trial flag true');
  const firstExpiresAt = first.data.expiresAt as string;
  const expiryDays = daysFromNow(firstExpiresAt);
  assert(
    expiryDays > DESKTOP_TRIAL_DAYS - 0.05 && expiryDays < DESKTOP_TRIAL_DAYS + 0.05,
    '9) expiresAt ≈ serverNow + 7 days',
    `days=${expiryDays}`
  );
  assert(first.data.trialExpiresAt === first.data.expiresAt, 'trialExpiresAt matches expiresAt');
  assert(
    first.data.offlineGraceDays === DESKTOP_TRIAL_OFFLINE_GRACE_DAYS,
    '10) trial offlineGraceDays is 0'
  );
  assert(!first.data.licenseKey, 'trial response does not leak licenseKey');
  assert(!first.data.activationPassword, 'trial response does not leak activationPassword');
  assert(!first.data.email && !first.data.emailNormalized, 'trial response does not leak email');
  assert(!first.data.phone && !first.data.phoneNormalized, 'trial response does not leak phone');

  const grantsAfterFirst = await prisma.desktopTrialGrant.count({
    where: { programId: koop!.id, deviceHash: deviceA },
  });
  assert(grantsAfterFirst === 1, 'exactly one grant for device A');

  const resumeSame = await json('POST', '/api/public/license/trial', trialBody);
  assert(
    resumeSame.data.success === true && resumeSame.data.expiresAt === firstExpiresAt,
    'same triple ACTIVE resumes existing grant without +7'
  );

  const sameDeviceDifferentContact = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(deviceA, emailB, phoneB)
  );
  assert(
    sameDeviceDifferentContact.data.code === TRIAL_ERROR_CODES.TRIAL_ALREADY_USED,
    '2) same device + different email/phone → TRIAL_ALREADY_USED'
  );

  const sameEmailDifferentDevice = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(deviceB, emailA, phoneC)
  );
  assert(
    sameEmailDifferentDevice.data.code === TRIAL_ERROR_CODES.TRIAL_ALREADY_USED,
    '3) same email + different device/phone → TRIAL_ALREADY_USED'
  );

  const samePhoneDifferentDevice = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(deviceB, emailC, phoneA)
  );
  assert(
    samePhoneDifferentDevice.data.code === TRIAL_ERROR_CODES.TRIAL_ALREADY_USED,
    '4) same phone + different device/email → TRIAL_ALREADY_USED'
  );

  const phoneFormatFirst = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(deviceC, emailD, '05321234567')
  );
  assert(phoneFormatFirst.status === 201 && phoneFormatFirst.data.success === true, '5a) 05321234567 accepted');
  const phoneFormatAgain = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(deviceD, emailE, '+90 532 123 45 67')
  );
  assert(
    phoneFormatAgain.data.code === TRIAL_ERROR_CODES.TRIAL_ALREADY_USED,
    '5b) +90 532 123 45 67 matches canonical phone → TRIAL_ALREADY_USED'
  );

  const emailCaseFirst = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(deviceE, 'TEST@example.com', phoneE)
  );
  assert(emailCaseFirst.status === 201 && emailCaseFirst.data.success === true, '6a) mixed-case email accepted');
  const emailCaseAgain = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(deviceF, 'test@example.com', phoneF)
  );
  assert(
    emailCaseAgain.data.code === TRIAL_ERROR_CODES.TRIAL_ALREADY_USED,
    '6b) email case change → TRIAL_ALREADY_USED'
  );

  await prisma.desktopTrialGrant.create({
    data: {
      programId: koop!.id,
      deviceHash: expiredDevice,
      expiresAt: new Date(Date.now() - 60_000),
      status: 'EXPIRED',
    },
  });
  const expiredRetry = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(expiredDevice, uniqueEmail('expired-device'), uniqueMobile(21))
  );
  assert(
    expiredRetry.data.code === TRIAL_ERROR_CODES.TRIAL_ALREADY_USED,
    '9) expired device cannot start another trial'
  );

  const expiredEmailDevice = sha256Hex(`koopplus-expired-email-${Date.now()}`);
  const expiredEmail = uniqueEmail('expired-email');
  await prisma.desktopTrialGrant.create({
    data: {
      programId: koop!.id,
      deviceHash: expiredEmailDevice,
      emailNormalized: expiredEmail,
      phoneNormalized: uniqueMobile(22),
      expiresAt: new Date(Date.now() - 60_000),
      status: 'EXPIRED',
    },
  });
  const expiredEmailRetry = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(deviceG, expiredEmail, uniqueMobile(23))
  );
  assert(
    expiredEmailRetry.data.code === TRIAL_ERROR_CODES.TRIAL_ALREADY_USED,
    '7) expired email cannot start another trial'
  );

  const expiredPhoneDevice = sha256Hex(`koopplus-expired-phone-${Date.now()}`);
  const expiredPhone = uniqueMobile(24);
  await prisma.desktopTrialGrant.create({
    data: {
      programId: koop!.id,
      deviceHash: expiredPhoneDevice,
      emailNormalized: uniqueEmail('expired-phone'),
      phoneNormalized: expiredPhone,
      expiresAt: new Date(Date.now() - 60_000),
      status: 'EXPIRED',
    },
  });
  const expiredPhoneRetry = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(deviceH, uniqueEmail('expired-phone-retry'), expiredPhone)
  );
  assert(
    expiredPhoneRetry.data.code === TRIAL_ERROR_CODES.TRIAL_ALREADY_USED,
    '8) expired phone cannot start another trial'
  );

  const fresh = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(
      sha256Hex(`koopplus-fresh-${Date.now()}-${Math.random()}`),
      uniqueEmail('fresh'),
      uniqueMobile(25)
    )
  );
  assert(fresh.status === 201 && fresh.data.success === true, '10) different device/email/phone → SUCCESS');

  await prisma.desktopTrialGrant.create({
    data: {
      programId: koop!.id,
      deviceHash: legacyDevice,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'ACTIVE',
    },
  });
  const legacyRetry = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(legacyDevice, uniqueEmail('legacy'), uniqueMobile(26))
  );
  assert(
    legacyRetry.data.code === TRIAL_ERROR_CODES.TRIAL_ALREADY_USED,
    '14) legacy grant without email/phone still blocks same deviceHash'
  );

  const mkdTrial = await json('POST', '/api/public/license/trial', {
    appCode: 'MUVEKKIL_KASA_DESKTOP',
    deviceHash: deviceA,
  });
  assert(
    mkdTrial.data.code === TRIAL_ERROR_CODES.TRIAL_NOT_AVAILABLE_FOR_PRODUCT,
    '15) MUVEKKIL_KASA_DESKTOP /trial rejected'
  );

  const otherProduct = await json('POST', '/api/public/license/trial', {
    appCode: 'SIFRE_KASASI_DESKTOP',
    deviceHash: deviceA,
  });
  assert(
    otherProduct.data.code === TRIAL_ERROR_CODES.TRIAL_NOT_AVAILABLE_FOR_PRODUCT,
    '15) other product /trial closed'
  );

  if (mkd) {
    await prisma.desktopTrialGrant.create({
      data: {
        programId: mkd.id,
        deviceHash: deviceA,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        status: 'ACTIVE',
      },
    });
    const sameHashOtherProgram = await prisma.desktopTrialGrant.count({
      where: { deviceHash: deviceA },
    });
    assert(
      sameHashOtherProgram >= 2,
      '15) same deviceHash allowed on different programId (not global unique)'
    );
  }

  const unknown = await json('POST', '/api/public/license/trial', {
    appCode: 'UNKNOWN_APP_CODE',
    deviceHash: deviceB,
  });
  assert(
    unknown.data.code === TRIAL_ERROR_CODES.PROGRAM_NOT_FOUND_OR_INACTIVE,
    '6) unknown appCode controlled error'
  );

  const badHash = await json('POST', '/api/public/license/trial', {
    appCode: APP_CODE_KOOPPLUS_DESKTOP,
    deviceHash: 'not-a-hash',
    email: uniqueEmail('bad-hash'),
    phone: uniqueMobile(27),
  });
  assert(
    badHash.data.code === TRIAL_ERROR_CODES.INVALID_DEVICE_HASH,
    '7) invalid deviceHash controlled error'
  );

  const invalidEmail = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(sha256Hex(`koopplus-invalid-email-${Date.now()}`), 'not-an-email', uniqueMobile(28))
  );
  assert(invalidEmail.data.code === TRIAL_ERROR_CODES.INVALID_EMAIL, '12) invalid email → validation error');

  const invalidPhone = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(sha256Hex(`koopplus-invalid-phone-${Date.now()}`), uniqueEmail('invalid-phone'), '02121234567')
  );
  assert(invalidPhone.data.code === TRIAL_ERROR_CODES.INVALID_PHONE, '13) invalid Turkish mobile → validation error');

  const [race1, race2] = await Promise.all([
    json('POST', '/api/public/license/trial', trialReq(raceDevice, emailRace, phoneRace)),
    json('POST', '/api/public/license/trial', trialReq(raceDevice, emailRace, phoneRace)),
  ]);
  const raceSuccesses = [race1, race2].filter((r) => r.data.success === true).length;
  const raceRejected = [race1, race2].filter(
    (r) => r.data.code === TRIAL_ERROR_CODES.TRIAL_ALREADY_USED
  ).length;
  const raceCount = await prisma.desktopTrialGrant.count({
    where: { programId: koop!.id, deviceHash: raceDevice },
  });
  assert(raceSuccesses >= 1, '11) concurrent trial: at least one success', `successes=${raceSuccesses}`);
  assert(
    raceSuccesses + raceRejected === 2,
    '11) concurrent trial: only success or TRIAL_ALREADY_USED',
    `successes=${raceSuccesses} rejected=${raceRejected}`
  );
  assert(raceCount === 1, '11) concurrent trial: one DesktopTrialGrant row');
  if (raceSuccesses === 2) {
    assert(
      race1.data.expiresAt === race2.data.expiresAt,
      '11) concurrent idempotent resume keeps same expiresAt'
    );
  }

  const valid = await json('POST', '/api/public/license/trial/validate', {
    appCode: APP_CODE_KOOPPLUS_DESKTOP,
    deviceHash: deviceA,
  });
  assert(valid.data.success === true && valid.data.valid === true, 'trial/validate active');
  assert(valid.data.offlineGraceDays === 0, 'trial validate offlineGraceDays is 0');

  const expiredValidate = await json('POST', '/api/public/license/trial/validate', {
    appCode: APP_CODE_KOOPPLUS_DESKTOP,
    deviceHash: expiredDevice,
  });
  assert(
    expiredValidate.data.code === TRIAL_ERROR_CODES.TRIAL_EXPIRED,
    'trial/validate expired → TRIAL_EXPIRED'
  );
  assert(
    expiredValidate.data.offlineGraceDays === 0,
    'expired trial does not offer offline grace'
  );
  const expiredGrantRow = await prisma.desktopTrialGrant.findUnique({
    where: {
      programId_deviceHash: { programId: koop!.id, deviceHash: expiredDevice },
    },
  });
  assert(!!expiredGrantRow, 'expired DesktopTrialGrant is not deleted');

  const sysCustomers = await prisma.customer.count({
    where: { email: SYSTEM_TRIAL_CUSTOMER_EMAIL },
  });
  assert(sysCustomers === 1, 'SYSTEM trial customer is idempotent (single row)');

  const clockDevice = sha256Hex(`koopplus-clock-${Date.now()}-${Math.random()}`);
  const clockTrial = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(clockDevice, uniqueEmail('clock'), uniqueMobile(29), {
      trialStart: '2010-01-01T00:00:00.000Z',
      currentTime: '2010-01-01T00:00:00.000Z',
      trialExpires: '2010-01-08T00:00:00.000Z',
    })
  );
  const clockDays = daysFromNow(clockTrial.data.expiresAt);
  assert(
    clockTrial.status === 201 &&
      clockDays > DESKTOP_TRIAL_DAYS - 0.05 &&
      clockDays < DESKTOP_TRIAL_DAYS + 0.05,
    '3) client trialStart/currentTime cannot shorten trial',
    `days=${clockDays}`
  );

  await prisma.program.update({ where: { id: koop!.id }, data: { isActive: false } });
  const inactiveDevice = sha256Hex(`koopplus-inactive-${Date.now()}-${Math.random()}`);
  const inactiveTrial = await json(
    'POST',
    '/api/public/license/trial',
    trialReq(inactiveDevice, uniqueEmail('inactive'), uniqueMobile(30))
  );
  assert(
    inactiveTrial.data.code === TRIAL_ERROR_CODES.PROGRAM_NOT_FOUND_OR_INACTIVE,
    '7) inactive KOOPPLUS_DESKTOP rejected'
  );
  await prisma.program.update({ where: { id: koop!.id }, data: { isActive: true } });

  const trialGrant = await prisma.desktopTrialGrant.findUnique({
    where: {
      programId_deviceHash: { programId: koop!.id, deviceHash: deviceA },
    },
    include: { license: true },
  });
  assert(!!trialGrant?.licenseId, 'trial grant linked to License');
  assert(
    typeof trialGrant?.license?.notes === 'string' &&
      trialGrant.license.notes.startsWith(SYSTEM_TRIAL_NOTES_PREFIX),
    'trial License notes marked SYSTEM_TRIAL'
  );

  const integrationHeaders = {
    'x-integration-secret': process.env.INTEGRATION_SECRET || 'change-me-integration-secret',
  };
  if (trialGrant?.license?.licenseKey) {
    const trialRenew = await json(
      'POST',
      '/api/integrations/website/renew-license',
      {
        orderNo: `TEST-TRIAL-RENEW-${Date.now()}`,
        licenseKey: trialGrant.license.licenseKey,
        appCode: APP_CODE_KOOPPLUS_DESKTOP,
        licenseDays: 365,
      },
      integrationHeaders
    );
    assert(
      trialRenew.status === 400 && trialRenew.data.code === 'TRIAL_LICENSE_NOT_RENEWABLE',
      'trial License cannot enter website renew'
    );
  } else {
    assert(false, 'trial License missing licenseKey for renew guard');
  }

  // --- existing paid MKD regression ---
  const customer = await json(
    'POST',
    '/api/admin/customers',
    {
      name: 'Trial Regression Customer',
      email: `trial-reg-${Date.now()}@example.com`,
    },
    auth
  );
  const license = await json(
    'POST',
    '/api/admin/licenses',
    {
      customerId: customer.data.id,
      programId: mkd!.id,
      licenseDays: 365,
      maxDevices: 1,
    },
    auth
  );
  assert(license.status === 201, '11) create paid MKD license');
  const licenseKey = license.data.license.licenseKey as string;
  const activationPassword = license.data.activationPassword as string;
  const paidDevice = 'device-hash-trial-regression-1';

  const activate = await json('POST', '/api/public/license/activate', {
    licenseKey,
    activationPassword,
    appCode: 'MUVEKKIL_KASA_DESKTOP',
    deviceHash: paidDevice,
    deviceName: 'Reg PC',
    platform: 'win32',
    appVersion: '1.0.0',
  });
  assert(activate.data.success === true, '11) /activate still succeeds');

  const overLimit = await json('POST', '/api/public/license/activate', {
    licenseKey,
    activationPassword,
    appCode: 'MUVEKKIL_KASA_DESKTOP',
    deviceHash: 'device-hash-trial-regression-2',
  });
  assert(overLimit.data.success === false, '13) 1-device limit still enforced');

  const validate = await json('POST', '/api/public/license/validate', {
    licenseKey,
    appCode: 'MUVEKKIL_KASA_DESKTOP',
    deviceHash: paidDevice,
  });
  assert(validate.data.valid === true, '12) /validate still succeeds');
  assert(validate.data.offlineGraceDays === 7, '12) paid offlineGraceDays still 7');

  const beforeExtend = new Date(validate.data.expiresAt as string);
  const extended = await json(
    'POST',
    `/api/admin/licenses/${license.data.license.id}/extend`,
    { days: 365 },
    auth
  );
  assert(extended.status === 200, '14) extend still works');
  const afterValidate = await json('POST', '/api/public/license/validate', {
    licenseKey,
    appCode: 'MUVEKKIL_KASA_DESKTOP',
    deviceHash: paidDevice,
  });
  const afterExpiry = new Date(afterValidate.data.expiresAt as string);
  assert(afterExpiry.getTime() > beforeExtend.getTime(), '14) validate returns new expiresAt');
  assert(afterValidate.data.offlineGraceDays === 7, '14) paid grace unchanged after extend');

  const mkdVsKoop = await json('POST', '/api/public/license/activate', {
    licenseKey,
    activationPassword,
    appCode: APP_CODE_KOOPPLUS_DESKTOP,
    deviceHash: paidDevice,
  });
  assert(mkdVsKoop.data.success === false, '25) MKD key + KOOPPLUS_DESKTOP appCode rejected');

  // --- paid KOOPPLUS_DESKTOP ---
  const koopCustomer = await json(
    'POST',
    '/api/admin/customers',
    {
      name: 'KoopPlus Paid Customer',
      email: `koopplus-paid-${Date.now()}@example.com`,
    },
    auth
  );
  const koopPaid = await json(
    'POST',
    '/api/admin/licenses',
    {
      customerId: koopCustomer.data.id,
      programId: koop!.id,
      licenseDays: KOOPPLUS_PROGRAM_DEFAULTS.defaultLicenseDays,
      maxDevices: KOOPPLUS_PROGRAM_DEFAULTS.defaultMaxDevices,
    },
    auth
  );
  assert(koopPaid.status === 201, '13) paid KoopPlus license created');
  const koopKey = koopPaid.data.license.licenseKey as string;
  const koopPass = koopPaid.data.activationPassword as string;
  const koopPaidDays = daysFromNow(koopPaid.data.license.expiresAt as string);
  assert(
    koopPaidDays > 364 && koopPaidDays < 366,
    '20) paid KoopPlus expiry ≈ now + 365 days',
    `days=${koopPaidDays}`
  );
  assert(koopPaid.data.license.maxDevices === 1, 'paid KoopPlus maxDevices is 1');

  const koopWrongPass = await json('POST', '/api/public/license/activate', {
    licenseKey: koopKey,
    activationPassword: 'wrong-password-xyz',
    appCode: APP_CODE_KOOPPLUS_DESKTOP,
    deviceHash: deviceA,
  });
  assert(koopWrongPass.data.success === false, '15) wrong activationPassword rejected');

  const koopWrongApp = await json('POST', '/api/public/license/activate', {
    licenseKey: koopKey,
    activationPassword: koopPass,
    appCode: 'MUVEKKIL_KASA_DESKTOP',
    deviceHash: deviceA,
  });
  assert(koopWrongApp.data.success === false, '24) KoopPlus key + MKD appCode rejected');

  const koopActivate = await json('POST', '/api/public/license/activate', {
    licenseKey: koopKey,
    activationPassword: koopPass,
    appCode: APP_CODE_KOOPPLUS_DESKTOP,
    deviceHash: deviceA,
    deviceName: 'Trial-then-paid PC',
    platform: 'win32',
    appVersion: '1.0.0',
  });
  assert(
    koopActivate.data.success === true,
    '14+21) trial-used device can activate paid KoopPlus'
  );

  const koopValidate = await json('POST', '/api/public/license/validate', {
    licenseKey: koopKey,
    appCode: APP_CODE_KOOPPLUS_DESKTOP,
    deviceHash: deviceA,
  });
  assert(koopValidate.data.valid === true, '16) paid KoopPlus validate on bound device');
  assert(koopValidate.data.offlineGraceDays === 7, '19) paid KoopPlus offlineGraceDays is 7');

  const secondPc = sha256Hex(`koopplus-paid-pc2-${Date.now()}-${Math.random()}`);
  const secondActivate = await json('POST', '/api/public/license/activate', {
    licenseKey: koopKey,
    activationPassword: koopPass,
    appCode: APP_CODE_KOOPPLUS_DESKTOP,
    deviceHash: secondPc,
  });
  assert(secondActivate.data.success === false, '17) second device rejected (maxDevices=1)');

  const reset = await json(
    'POST',
    `/api/admin/licenses/${koopPaid.data.license.id}/reset-devices`,
    {},
    auth
  );
  assert(reset.status === 200, '18) admin reset-devices succeeds');

  const afterResetNew = await json('POST', '/api/public/license/activate', {
    licenseKey: koopKey,
    activationPassword: koopPass,
    appCode: APP_CODE_KOOPPLUS_DESKTOP,
    deviceHash: secondPc,
  });
  assert(afterResetNew.data.success === true, '18) new device activates after reset');

  const afterResetOld = await json('POST', '/api/public/license/activate', {
    licenseKey: koopKey,
    activationPassword: koopPass,
    appCode: APP_CODE_KOOPPLUS_DESKTOP,
    deviceHash: deviceA,
  });
  assert(
    afterResetOld.data.success === false,
    '18) revoked original deviceHash stays rejected after reset'
  );

  const keyBeforeExtend = koopKey;
  const paidBeforeExtend = new Date(koopValidate.data.expiresAt as string);
  const koopExtend = await json(
    'POST',
    `/api/admin/licenses/${koopPaid.data.license.id}/extend`,
    { days: 365 },
    auth
  );
  assert(koopExtend.status === 200, '22) paid KoopPlus admin extend');
  assert(koopExtend.data.licenseKey === keyBeforeExtend, '22) licenseKey unchanged after extend');
  const paidAfterExtend = new Date(koopExtend.data.expiresAt as string);
  assert(paidAfterExtend.getTime() > paidBeforeExtend.getTime(), '23) expiresAt moved forward');

  const websiteRenew = await json(
    'POST',
    '/api/integrations/website/renew-license',
    {
      orderNo: `TEST-KOOPPLUS-RENEW-${Date.now()}`,
      licenseKey: koopKey,
      appCode: APP_CODE_KOOPPLUS_DESKTOP,
      licenseDays: 365,
    },
    integrationHeaders
  );
  assert(websiteRenew.status === 200 && websiteRenew.data.success === true, 'paid KoopPlus website renew');
  assert(websiteRenew.data.licenseKey === koopKey, '22) website renew keeps same licenseKey');
  assert(
    new Date(websiteRenew.data.newExpiresAt as string).getTime() > paidAfterExtend.getTime(),
    '23) website renew extends expiresAt'
  );

  const expiredPaid = await json(
    'POST',
    '/api/admin/licenses',
    {
      customerId: koopCustomer.data.id,
      programId: koop!.id,
      licenseDays: 30,
      maxDevices: 1,
    },
    auth
  );
  const expiredKey = expiredPaid.data.license.licenseKey as string;
  const past = new Date();
  past.setDate(past.getDate() - 10);
  await prisma.license.update({
    where: { id: expiredPaid.data.license.id },
    data: { expiresAt: past, status: 'EXPIRED' },
  });
  const extendExpired = await json(
    'POST',
    `/api/admin/licenses/${expiredPaid.data.license.id}/extend`,
    { days: 365 },
    auth
  );
  assert(extendExpired.status === 200, 'expired paid extend from now');
  assert(extendExpired.data.licenseKey === expiredKey, 'expired extend keeps same key');
  const expiredExtendDays = daysFromNow(extendExpired.data.expiresAt as string);
  assert(
    expiredExtendDays > 364 && expiredExtendDays < 366,
    'expired admin extend: now + 365 days',
    `days=${expiredExtendDays}`
  );

  const grantAfterPaid = await prisma.desktopTrialGrant.findUnique({
    where: {
      programId_deviceHash: { programId: koop!.id, deviceHash: deviceA },
    },
  });
  assert(!!grantAfterPaid, 'DesktopTrialGrant remains after paid activation');

  await prisma.$disconnect();
  await new Promise<void>((resolve, reject) => {
    server.close((e) => (e ? reject(e) : resolve()));
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
