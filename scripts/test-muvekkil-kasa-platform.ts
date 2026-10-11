/**
 * Müvekkil Kasa Desktop platform lisans testleri (+ BH/Aktüerya regresyonu).
 * Yalnız lokal DATABASE_URL. Production/Railway'e yazmaz.
 */
import { PrismaClient } from '@prisma/client';
import app from '../src/app';
import { hashPassword } from '../src/utils/password';
import { assertLocalDatabaseUrl } from './assertLocalTestTarget';

const INTEGRATION_SECRET = process.env.INTEGRATION_SECRET || 'change-me-integration-secret';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@woontegra.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-strong-password';
const MK = 'MUVEKKIL_KASA_DESKTOP';
const ORDER_PREFIX = 'TEST-MKPLAT-';

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
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function ensureAdmin() {
  const existing = await prisma.admin.findUnique({ where: { email: ADMIN_EMAIL } });
  if (existing) return;
  await prisma.admin.create({
    data: { email: ADMIN_EMAIL, passwordHash: await hashPassword(ADMIN_PASSWORD), name: 'Test Admin' },
  });
}

async function ensureProgram(auth: Record<string, string>, body: Record<string, unknown>) {
  const created = await json('POST', '/api/admin/programs', body, auth);
  if (created.status === 201) return created;
  const programs = await json('GET', '/api/admin/programs', undefined, auth);
  const found = Array.isArray(programs.data)
    ? programs.data.find((p: { appCode: string }) => p.appCode === body.appCode)
    : null;
  return { status: found ? 200 : created.status, data: found ?? created.data };
}

async function main() {
  console.log('\n=== Müvekkil Kasa Desktop platform license tests ===\n');
  assertLocalDatabaseUrl();
  await ensureAdmin();

  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await json('POST', '/api/admin/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  assert(login.status === 200 && !!login.data.token, 'Admin login');
  const auth = { Authorization: `Bearer ${login.data.token as string}` };
  const integrationHeaders = { 'x-integration-secret': INTEGRATION_SECRET };

  for (const [appCode, name] of [
    [MK, 'Müvekkil Kasa Defteri Desktop'],
    ['BILIRKISI_DESKTOP', 'Bilirkişi Desktop'],
    ['AKTUERYA_DESKTOP', 'Aktüerya Hesaplama Desktop'],
  ] as const) {
    const program = await ensureProgram(auth, { appCode, name, productType: 'DESKTOP' });
    assert(program.status === 201 || program.status === 200, `${appCode} program present`, String(program.status));
  }

  const stamp = Date.now();
  let seq = 0;
  const order = (appCode: string, platform?: unknown) => {
    const orderNo = `${ORDER_PREFIX}${appCode}-${stamp}-${seq++}`;
    return json(
      'POST',
      '/api/integrations/website/order-license',
      {
        customerName: 'MK Platform Test',
        customerEmail: `mk-platform-${stamp}-${seq}@example.invalid`,
        appCode,
        orderNo,
        licenseDays: 365,
        ...(platform === undefined ? {} : { platform }),
      },
      integrationHeaders
    ).then((res) => ({ ...res, orderNo }));
  };
  const activate = (
    appCode: string,
    created: { data: Record<string, unknown> },
    deviceHash: string,
    platform?: string
  ) =>
    json('POST', '/api/public/license/activate', {
      licenseKey: created.data.licenseKey,
      activationPassword: created.data.activationPassword,
      appCode,
      deviceHash,
      deviceName: 'test-device',
      ...(platform === undefined ? {} : { platform }),
    });
  const validate = (appCode: string, licenseKey: unknown, deviceHash: string, platform?: string) =>
    json('POST', '/api/public/license/validate', {
      licenseKey,
      appCode,
      deviceHash,
      ...(platform === undefined ? {} : { platform }),
    });

  // Yeni Windows MK lisansı + eski 0.1.14 istemcisi
  const mkWin = await order(MK, 'WINDOWS');
  assert(mkWin.status === 201 && mkWin.data.platform === 'WINDOWS', 'MK order with WINDOWS stores License.platform', String(mkWin.data.platform));
  const mkWinRow = await prisma.license.findFirst({ where: { notes: `Website sipariş no: ${mkWin.orderNo}` } });
  assert(mkWinRow?.platform === 'WINDOWS', 'MK DB platform WINDOWS');
  const winDevice = `mk-win-${stamp}`;
  const winAct = await activate(MK, mkWin, winDevice, 'win32-x64');
  assert(winAct.status === 200 && winAct.data.success === true, 'MK 0.1.14 Windows activation (win32-x64) succeeds', JSON.stringify(winAct.data));
  const oldClientValidate = await validate(MK, mkWin.data.licenseKey, winDevice);
  assert(oldClientValidate.data.valid === true, 'MK 0.1.14 validate without platform is valid via device platform', JSON.stringify(oldClientValidate.data));
  const newWinValidate = await validate(MK, mkWin.data.licenseKey, winDevice, 'WINDOWS');
  assert(newWinValidate.data.valid === true, 'MK Windows validate with explicit WINDOWS is valid');
  const winOnMac = await validate(MK, mkWin.data.licenseKey, winDevice, 'darwin-arm64');
  assert(winOnMac.data.valid === false && winOnMac.data.code === 'PLATFORM_MISMATCH', 'MK Windows license with explicit macOS keeps PLATFORM_MISMATCH');
  const winActOnMac = await activate(MK, mkWin, `mk-win-on-mac-${stamp}`, 'darwin-arm64');
  assert(winActOnMac.data.code === 'PLATFORM_MISMATCH', 'MK Windows license cannot be activated on macOS');
  const unknownDevice = await validate(MK, mkWin.data.licenseKey, `mk-unknown-${stamp}`);
  assert(
    unknownDevice.data.valid === false && unknownDevice.data.code !== 'PLATFORM_MISMATCH' && unknownDevice.data.message === 'Cihaz kayıtlı değil',
    'MK validate without platform on unregistered device reports device error',
    JSON.stringify(unknownDevice.data)
  );

  // Yeni macOS MK lisansı
  const mkMac = await order(MK, 'darwin');
  assert(mkMac.status === 201 && mkMac.data.platform === 'MACOS', 'MK order with darwin stores MACOS', String(mkMac.data.platform));
  const macDevice = `mk-mac-${stamp}`;
  const macActOnWin = await activate(MK, mkMac, `mk-mac-on-win-${stamp}`, 'win32-x64');
  assert(macActOnWin.data.code === 'PLATFORM_MISMATCH', 'MK macOS license cannot be activated on Windows');
  const macAct = await activate(MK, mkMac, macDevice, 'darwin-arm64');
  assert(macAct.status === 200 && macAct.data.success === true, 'MK macOS activation succeeds');
  const macNoPlatform = await validate(MK, mkMac.data.licenseKey, macDevice);
  assert(macNoPlatform.data.valid === true, 'MK macOS validate without platform is valid via device platform');
  const macExplicit = await validate(MK, mkMac.data.licenseKey, macDevice, 'darwin-arm64');
  assert(macExplicit.data.valid === true, 'MK macOS validate with explicit macOS is valid');
  const macOnWin = await validate(MK, mkMac.data.licenseKey, macDevice, 'win32-x64');
  assert(macOnWin.data.code === 'PLATFORM_MISMATCH', 'MK macOS license with explicit Windows keeps PLATFORM_MISMATCH');

  // Geçiş: platform henüz zorunlu değil, eski platformsuz lisans
  const mkLegacy = await order(MK);
  assert(mkLegacy.status === 201, 'MK order without platform is still accepted', String(mkLegacy.status));
  assert(mkLegacy.data.platform === null, 'MK order without platform stays null', String(mkLegacy.data.platform));
  const legacyDevice = `mk-legacy-${stamp}`;
  const legacyAct = await activate(MK, mkLegacy, legacyDevice, 'win32-x64');
  assert(legacyAct.data.success === true, 'MK legacy null-platform license activates on Windows');
  const legacyNoPlatform = await validate(MK, mkLegacy.data.licenseKey, legacyDevice);
  assert(legacyNoPlatform.data.valid === true, 'MK legacy license valid without platform');
  const legacyMac = await validate(MK, mkLegacy.data.licenseKey, legacyDevice, 'darwin');
  assert(legacyMac.data.valid === true, 'MK legacy license stays valid with any platform');
  const legacyRow = await prisma.license.findFirst({ where: { notes: `Website sipariş no: ${mkLegacy.orderNo}` } });
  assert(legacyRow?.platform === null, 'MK legacy license platform is not backfilled by validate');

  const mkInvalid = await order(MK, 'linux');
  assert(mkInvalid.status === 400, 'MK order with unknown platform is rejected', String(mkInvalid.status));
  const mkInvalidRow = await prisma.license.findFirst({ where: { notes: `Website sipariş no: ${mkInvalid.orderNo}` } });
  assert(!mkInvalidRow, 'MK rejected order does not create a license');

  // BH ve Aktüerya regresyonu: platform zorunlu, cihaz yedeği yok
  const bhMissing = await order('BILIRKISI_DESKTOP');
  assert(bhMissing.status === 400, 'BILIRKISI_DESKTOP order without platform still rejected');
  const bhWin = await order('BILIRKISI_DESKTOP', 'WINDOWS');
  assert(bhWin.status === 201 && bhWin.data.platform === 'WINDOWS', 'BILIRKISI_DESKTOP Windows order stored');
  const bhDevice = `bh-win-${stamp}`;
  const bhAct = await activate('BILIRKISI_DESKTOP', bhWin, bhDevice, 'WINDOWS');
  assert(bhAct.data.success === true, 'BILIRKISI_DESKTOP Windows activation succeeds');
  const bhValid = await validate('BILIRKISI_DESKTOP', bhWin.data.licenseKey, bhDevice, 'WINDOWS');
  assert(bhValid.data.valid === true, 'BILIRKISI_DESKTOP Windows validate succeeds');
  const bhNoPlatform = await validate('BILIRKISI_DESKTOP', bhWin.data.licenseKey, bhDevice);
  assert(bhNoPlatform.data.code === 'PLATFORM_MISMATCH', 'BILIRKISI_DESKTOP validate without platform still mismatches');
  const bhOnMac = await validate('BILIRKISI_DESKTOP', bhWin.data.licenseKey, bhDevice, 'MACOS');
  assert(bhOnMac.data.code === 'PLATFORM_MISMATCH', 'BILIRKISI_DESKTOP Windows license rejected on macOS');

  const akMissing = await order('AKTUERYA_DESKTOP');
  assert(akMissing.status === 400, 'AKTUERYA_DESKTOP order without platform still rejected');
  const akMac = await order('AKTUERYA_DESKTOP', 'MACOS');
  assert(akMac.status === 201 && akMac.data.platform === 'MACOS', 'AKTUERYA_DESKTOP macOS order stored');
  const akDevice = `ak-mac-${stamp}`;
  const akAct = await activate('AKTUERYA_DESKTOP', akMac, akDevice, 'darwin-arm64');
  assert(akAct.data.success === true, 'AKTUERYA_DESKTOP macOS activation succeeds');
  const akNoPlatform = await validate('AKTUERYA_DESKTOP', akMac.data.licenseKey, akDevice);
  assert(akNoPlatform.data.code === 'PLATFORM_MISMATCH', 'AKTUERYA_DESKTOP validate without platform still mismatches');

  const created = await prisma.license.findMany({
    where: { notes: { contains: ORDER_PREFIX } },
    select: { id: true },
  });
  const ids = created.map((row) => row.id);
  await prisma.licenseEvent.deleteMany({ where: { licenseId: { in: ids } } });
  await prisma.licenseDevice.deleteMany({ where: { licenseId: { in: ids } } });
  await prisma.license.deleteMany({ where: { id: { in: ids } } });

  await prisma.$disconnect();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
