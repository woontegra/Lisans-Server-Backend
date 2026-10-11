/**
 * Müvekkil Kasa demo test kimliği — SUPER_ADMIN sıfırlama testleri.
 * Yalnız lokal DATABASE_URL. Production/Railway'e yazmaz.
 */
import { createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/utils/password';
import { assertLocalDatabaseUrl } from './assertLocalTestTarget';

const SUPER_EMAIL = 'super-admin-test@example.invalid';
const SUPER_PASSWORD = 'super-admin-test-password';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@woontegra.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-strong-password';
const MK = 'MUVEKKIL_KASA_DESKTOP';
const TEST_EMAIL = 'info@woontegra.com';
const TEST_PHONE = '05323171755';
const TEST_PHONE_CANONICAL = '+905323171755';
const RESET_PATH = '/api/admin/desktop-trials/test-identity/reset';

process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
process.env.TRIAL_RATE_LIMIT_MAX ??= '500';

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

async function json(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, data };
}

const device = (label: string) => createHash('sha256').update(`trial-test-reset:${label}`).digest('hex');

async function ensureAdmin(email: string, password: string) {
  if (await prisma.admin.findUnique({ where: { email } })) return;
  await prisma.admin.create({ data: { email, passwordHash: await hashPassword(password), name: email } });
}

async function login(email: string, password: string) {
  const res = await json('POST', '/api/admin/login', { email, password });
  return { Authorization: `Bearer ${res.data.token as string}` };
}

async function ensureProgram(auth: Record<string, string>, appCode: string, name: string) {
  const created = await json('POST', '/api/admin/programs', { appCode, name, productType: 'DESKTOP' }, auth);
  if (created.status === 201) return true;
  const list = await json('GET', '/api/admin/programs', undefined, auth);
  return Array.isArray(list.data) && list.data.some((p: { appCode: string }) => p.appCode === appCode);
}

const trial = (body: Record<string, unknown>) =>
  json('POST', '/api/public/license/trial', {
    appCode: MK,
    deviceName: 'Test PC',
    platform: 'win32',
    appVersion: '0.1.14',
    ...body,
  });

const validateTrial = (deviceHash: string) =>
  json('POST', '/api/public/license/trial/validate', { appCode: MK, deviceHash });

async function testGrant() {
  const program = await prisma.program.findUniqueOrThrow({ where: { appCode: MK } });
  return prisma.desktopTrialGrant.findFirst({
    where: { programId: program.id, emailNormalized: TEST_EMAIL, phoneNormalized: TEST_PHONE_CANONICAL },
    include: { license: { include: { devices: true } } },
  });
}

async function main() {
  console.log('\n=== Müvekkil Kasa demo test kimliği sıfırlama testleri ===\n');
  assertLocalDatabaseUrl();
  await ensureAdmin(ADMIN_EMAIL, ADMIN_PASSWORD);
  await ensureAdmin(SUPER_EMAIL, SUPER_PASSWORD);

  const { default: app } = await import('../src/app');
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const adminAuth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const superAuth = await login(SUPER_EMAIL, SUPER_PASSWORD);
  for (const [code, name] of [
    [MK, 'Müvekkil Kasa Defteri Desktop'],
    ['BILIRKISI_DESKTOP', 'Bilirkişi Desktop'],
    ['KOOPPLUS_DESKTOP', 'KoopPlus'],
    ['AKTUERYA_DESKTOP', 'Aktüerya Hesaplama Desktop'],
  ] as const) {
    assert(await ensureProgram(adminAuth, code, name), `${code} program present`);
  }

  // Önceki çalıştırmadan kalan test kimliği kaydı varsa temizle.
  await json('POST', RESET_PATH, { appCode: MK }, superAuth);

  const stamp = Date.now();
  const devTester = device(`tester-${stamp}`);
  const devOther = device(`other-${stamp}`);
  const devThird = device(`third-${stamp}`);

  console.log('\n-- Yetkilendirme --');
  const noAuth = await json('POST', RESET_PATH, { appCode: MK });
  assert(noAuth.status === 401, 'token olmadan sıfırlama 401', String(noAuth.status));
  const plainAdmin = await json('POST', RESET_PATH, { appCode: MK }, adminAuth);
  assert(plainAdmin.status === 403, 'SUPER_ADMIN olmayan admin 403', String(plainAdmin.status));
  const fakeToken = await json('POST', RESET_PATH, { appCode: MK }, { Authorization: 'Bearer forged.token.value' });
  assert(fakeToken.status === 401, 'sahte token 401', String(fakeToken.status));
  for (const code of ['BILIRKISI_DESKTOP', 'AKTUERYA_DESKTOP', 'KOOPPLUS_DESKTOP']) {
    const other = await json('POST', RESET_PATH, { appCode: code }, superAuth);
    assert(
      other.status === 400 && other.data.code === 'TEST_RESET_NOT_ALLOWED',
      `${code} için test sıfırlaması kapalı`,
      JSON.stringify(other.data)
    );
  }

  console.log('\n-- Test kimliği: ilk demo ve yetkisiz tekrar --');
  const first = await trial({ deviceHash: devTester, email: TEST_EMAIL, phone: TEST_PHONE });
  assert(first.status === 201 && first.data.success === true && first.data.resumed === false, 'test kimliği ilk demo', JSON.stringify(first.data));
  const resumed = await trial({ deviceHash: devTester, email: 'INFO@woontegra.com', phone: '+90 532 317 17 55' });
  assert(resumed.data.resumed === true && resumed.data.expiresAt === first.data.expiresAt, 'aynı kimlik+cihaz mevcut demoyu sürdürür, +7 gün vermez');
  for (const [label, body] of [
    ['test kimliği başka cihaz', { deviceHash: devOther, email: TEST_EMAIL, phone: TEST_PHONE }],
    ['test e-postası başka telefon/cihaz', { deviceHash: devOther, email: TEST_EMAIL, phone: '05329990011' }],
    ['test telefonu başka e-posta/cihaz', { deviceHash: devThird, email: `x-${stamp}@example.invalid`, phone: TEST_PHONE }],
  ] as const) {
    const r = await trial(body);
    assert(r.data.code === 'TRIAL_ALREADY_USED', `yetkisiz: ${label} → TRIAL_ALREADY_USED`, JSON.stringify(r.data));
  }

  console.log('\n-- Normal kullanıcı kuralları --');
  const userEmail = `normal-${stamp}@example.invalid`;
  const userPhone = `0532${String(stamp).slice(-7)}`;
  const devUser = device(`user-${stamp}`);
  const userFirst = await trial({ deviceHash: devUser, email: userEmail, phone: userPhone });
  assert(userFirst.status === 201 && userFirst.data.resumed === false, 'normal kullanıcı ilk demo');
  const userChecks = [
    ['aynı e-posta', { deviceHash: device(`u2-${stamp}`), email: userEmail, phone: '05321110022' }],
    ['aynı telefon', { deviceHash: device(`u3-${stamp}`), email: `n2-${stamp}@example.invalid`, phone: userPhone }],
    ['aynı cihaz', { deviceHash: devUser, email: `n3-${stamp}@example.invalid`, phone: '05321110033' }],
  ] as const;
  for (const [label, body] of userChecks) {
    const r = await trial(body);
    assert(r.data.code === 'TRIAL_ALREADY_USED', `normal kullanıcı ${label} ile ikinci demo alamaz`, JSON.stringify(r.data));
  }
  const program = await prisma.program.findUniqueOrThrow({ where: { appCode: MK } });
  const userGrantBefore = await prisma.desktopTrialGrant.findUniqueOrThrow({
    where: { programId_platformScope_deviceHash: { programId: program.id, platformScope: '', deviceHash: devUser } },
    include: { license: true },
  });

  console.log('\n-- Test kimliğiyle aynı cihazda ücretli lisans --');
  const paid = await json(
    'POST',
    '/api/admin/licenses',
    {
      newCustomer: { name: 'Woontegra Test', email: TEST_EMAIL, phone: TEST_PHONE },
      programId: program.id,
      licenseDays: 365,
      notes: 'paid regression',
    },
    adminAuth
  );
  assert(paid.status === 201, 'ücretli MK lisansı oluşturuldu', JSON.stringify(paid.data).slice(0, 200));
  const paidActivate = await json('POST', '/api/public/license/activate', {
    licenseKey: paid.data.license?.licenseKey,
    activationPassword: paid.data.activationPassword,
    appCode: MK,
    deviceHash: devTester,
    platform: 'win32',
  });
  assert(paidActivate.data.success === true, 'ücretli lisans test cihazında aktive', JSON.stringify(paidActivate.data));

  console.log('\n-- Dry-run --');
  const before = await testGrant();
  const dry = await json('POST', RESET_PATH, { appCode: MK, dryRun: true }, superAuth);
  assert(
    dry.status === 200 && dry.data.dryRun === true && dry.data.wouldResetGrantIds?.length === 1 && dry.data.conflicts?.length === 0,
    'dry-run tek test kaydını gösterir',
    JSON.stringify(dry.data)
  );
  const afterDry = await testGrant();
  assert(!!afterDry && afterDry.status === before?.status && afterDry.license?.status === 'ACTIVE', 'dry-run hiçbir şeyi değiştirmez');

  console.log('\n-- SUPER_ADMIN sıfırlaması (aktif demo) --');
  const oldLicenseId = before!.licenseId!;
  const reset = await json('POST', RESET_PATH, { appCode: MK }, superAuth);
  assert(reset.status === 200 && reset.data.resetCount === 1, 'sıfırlama 1 test kaydını kapattı', JSON.stringify(reset.data));
  const oldGrant = await prisma.desktopTrialGrant.findUniqueOrThrow({ where: { id: before!.id } });
  assert(oldGrant.status === 'EXPIRED' && oldGrant.expiresAt <= new Date(), 'eski demo kaydı EXPIRED ve süresi bitti');
  assert(oldGrant.emailNormalized === null && oldGrant.phoneNormalized === null && oldGrant.deviceHash !== devTester, 'eski demo kaydının kimlik alanları serbest');
  const oldLicense = await prisma.license.findUniqueOrThrow({
    where: { id: oldLicenseId },
    include: { devices: true, events: true },
  });
  assert(oldLicense.status === 'PASSIVE' && oldLicense.expiresAt <= new Date(), 'eski test lisansı PASSIVE ve süresi bitti');
  assert(oldLicense.devices.every((d) => d.status === 'REVOKED'), 'eski test lisansının cihazı REVOKED');
  assert(oldLicense.notes?.startsWith('SYSTEM_TRIAL:') === true && oldLicense.notes.includes('TEST_TRIAL_RESET'), 'lisans notunda SYSTEM_TRIAL korunur ve sıfırlama işareti eklenir');
  const auditEvent = oldLicense.events.find((e) => e.message?.includes('TEST_TRIAL_RESET'));
  assert(
    !!auditEvent && auditEvent.eventType === 'LICENSE_DISABLED' &&
      auditEvent.message!.includes(`admin=${SUPER_EMAIL}`) &&
      auditEvent.message!.includes(`device=${devTester}`) &&
      auditEvent.message!.includes(`email=${TEST_EMAIL}`),
    'denetim kaydı: admin, cihaz ve kimlik bilgisiyle LicenseEvent'
  );

  const validateAfterReset = await validateTrial(devTester);
  assert(validateAfterReset.data.code === 'TRIAL_NOT_FOUND', 'eski demo artık doğrulanmaz', JSON.stringify(validateAfterReset.data));

  console.log('\n-- Aynı e-posta, telefon ve cihazla yeni demo --');
  const second = await trial({ deviceHash: devTester, email: TEST_EMAIL, phone: TEST_PHONE });
  const secondDays = (new Date(second.data.expiresAt).getTime() - Date.now()) / 86_400_000;
  assert(second.status === 201 && second.data.resumed === false, 'yeni demo başladı', JSON.stringify(second.data));
  assert(secondDays > 6.9 && secondDays <= 7.01, 'yeni demo 7 gün', String(secondDays));
  const secondValidate = await validateTrial(devTester);
  assert(secondValidate.data.valid === true, 'yeni demo doğrulanır (0.1.14/0.1.15 akışı)');
  const newGrant = await testGrant();
  assert(!!newGrant && newGrant.licenseId !== oldLicenseId, 'yeni demo yeni sistem lisansına bağlı');

  const again = await trial({ deviceHash: devOther, email: TEST_EMAIL, phone: TEST_PHONE });
  assert(again.data.code === 'TRIAL_ALREADY_USED', 'sıfırlamadan sonra da test kimliği ikinci cihazda demo alamaz');

  console.log('\n-- Süresi dolmuş test demosu --');
  await prisma.desktopTrialGrant.update({
    where: { id: newGrant!.id },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const expiredValidate = await validateTrial(devTester);
  assert(expiredValidate.data.code === 'TRIAL_EXPIRED', 'süre dolunca TRIAL_EXPIRED');
  const expiredRetry = await trial({ deviceHash: devTester, email: TEST_EMAIL, phone: TEST_PHONE });
  assert(expiredRetry.data.code === 'TRIAL_ALREADY_USED', 'sıfırlama olmadan süresi dolan test demosu yenilenmez');
  const resetExpired = await json('POST', RESET_PATH, { appCode: MK }, superAuth);
  assert(resetExpired.data.resetCount === 1, 'süresi dolmuş test demosu sıfırlandı');
  const third = await trial({ deviceHash: devTester, email: TEST_EMAIL, phone: TEST_PHONE });
  assert(third.status === 201 && third.data.resumed === false, 'sıfırlamadan sonra yeniden 7 günlük demo');

  console.log('\n-- Diğer kayıtlar etkilenmedi --');
  const userGrantAfter = await prisma.desktopTrialGrant.findUniqueOrThrow({
    where: { id: userGrantBefore.id },
    include: { license: true },
  });
  assert(
    userGrantAfter.status === userGrantBefore.status &&
      userGrantAfter.expiresAt.getTime() === userGrantBefore.expiresAt.getTime() &&
      userGrantAfter.emailNormalized === userEmail &&
      userGrantAfter.license?.status === 'ACTIVE' &&
      userGrantAfter.license.updatedAt.getTime() === userGrantBefore.license!.updatedAt.getTime(),
    'normal kullanıcının demo kaydı ve lisansı değişmedi'
  );
  const userStill = await trial({ deviceHash: device(`u4-${stamp}`), email: userEmail, phone: '05321110044' });
  assert(userStill.data.code === 'TRIAL_ALREADY_USED', 'sıfırlama normal kullanıcıya yeni hak açmadı');
  const paidAfter = await prisma.license.findUniqueOrThrow({
    where: { id: paid.data.license.id },
    include: { devices: true },
  });
  assert(
    paidAfter.status === 'ACTIVE' && paidAfter.devices.length === 1 && paidAfter.devices[0].status === 'ACTIVE',
    'aynı kişinin ücretli lisansı ve cihaz aktivasyonu değişmedi'
  );
  const paidValidate = await json('POST', '/api/public/license/validate', {
    licenseKey: paid.data.license.licenseKey,
    appCode: MK,
    deviceHash: devTester,
  });
  assert(paidValidate.data.valid === true, 'ücretli lisans 0.1.14 gibi platformsuz validate ile geçerli');

  console.log('\n-- Tek alanı eşleşen kayıt (başkasına ait olabilir) --');
  await json('POST', RESET_PATH, { appCode: MK }, superAuth);
  const devStranger = device(`stranger-${stamp}`);
  const stranger = await trial({ deviceHash: devStranger, email: TEST_EMAIL, phone: '05327770088' });
  assert(stranger.status === 201, 'boşalan test e-postasını başkası normal kuralla bir kez kullanabilir');
  const strangerAgain = await trial({ deviceHash: device(`stranger2-${stamp}`), email: TEST_EMAIL, phone: '05327770099' });
  assert(strangerAgain.data.code === 'TRIAL_ALREADY_USED', 'ikinci kez alamaz');
  const conflictReset = await json('POST', RESET_PATH, { appCode: MK }, superAuth);
  assert(
    conflictReset.data.resetCount === 0 && conflictReset.data.conflicts?.[0]?.matchedOn === 'email',
    'yalnız e-postası eşleşen kayıt sıfırlanmaz, çakışma olarak raporlanır',
    JSON.stringify(conflictReset.data)
  );
  const strangerValidate = await validateTrial(devStranger);
  assert(strangerValidate.data.valid === true, 'çakışan kaydın demosu bozulmadı');

  console.log('\n-- Bilirkişi: otomatik muafiyet yok --');
  const bhDev = device(`bh-${stamp}`);
  const bhFirst = await trial({ appCode: 'BILIRKISI_DESKTOP', platform: 'WINDOWS', deviceHash: bhDev, email: TEST_EMAIL, phone: TEST_PHONE });
  assert(bhFirst.status === 201 || bhFirst.data.code === 'TRIAL_ALREADY_USED', 'BH test kimliği normal kuralla işlenir', JSON.stringify(bhFirst.data));
  const bhSecond = await trial({ appCode: 'BILIRKISI_DESKTOP', platform: 'WINDOWS', deviceHash: device(`bh2-${stamp}`), email: TEST_EMAIL, phone: TEST_PHONE });
  assert(bhSecond.data.code === 'TRIAL_ALREADY_USED', 'BH test kimliğiyle ikinci demo alınamaz', JSON.stringify(bhSecond.data));

  server.close();
  await prisma.$disconnect();
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
