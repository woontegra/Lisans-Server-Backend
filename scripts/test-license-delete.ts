/**
 * Admin "Lisansı Sil" (soft-delete) yetki ve koşul testleri.
 * Yalnız lokal DATABASE_URL. Production/Railway'e yazmaz; mail göndermez.
 */
import { LicenseStatus, PrismaClient } from '@prisma/client';
import app from '../src/app';
import { config } from '../src/config';
import { hashPassword } from '../src/utils/password';
import { assertLocalDatabaseUrl } from './assertLocalTestTarget';

const INTEGRATION_SECRET = process.env.INTEGRATION_SECRET || 'change-me-integration-secret';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@woontegra.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-strong-password';
const PLAIN_EMAIL = 'plain-admin-delete-test@example.invalid';
const PLAIN_PASSWORD = 'plain-admin-delete-test-pass';
const MK = 'MUVEKKIL_KASA_DESKTOP';
const NOTE_PREFIX = 'TEST-LICDEL-';

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

async function ensureAdmin(email: string, password: string) {
  const existing = await prisma.admin.findUnique({ where: { email } });
  if (existing) {
    await prisma.admin.update({ where: { email }, data: { passwordHash: await hashPassword(password) } });
    return;
  }
  await prisma.admin.create({ data: { email, passwordHash: await hashPassword(password), name: 'Test Admin' } });
}

async function main() {
  console.log('\n=== Admin license soft-delete tests ===\n');
  assertLocalDatabaseUrl();
  config.smtp.host = '';
  config.superAdminEmails.splice(0, config.superAdminEmails.length, ADMIN_EMAIL.toLowerCase());

  await ensureAdmin(ADMIN_EMAIL, ADMIN_PASSWORD);
  await ensureAdmin(PLAIN_EMAIL, PLAIN_PASSWORD);

  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = async (email: string, password: string) => {
    const r = await json('POST', '/api/admin/login', { email, password });
    return { Authorization: `Bearer ${r.data.token as string}` };
  };
  const superAuth = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const plainAuth = await login(PLAIN_EMAIL, PLAIN_PASSWORD);
  const integrationHeaders = { 'x-integration-secret': INTEGRATION_SECRET };

  const meSuper = await json('GET', '/api/admin/me', undefined, superAuth);
  const mePlain = await json('GET', '/api/admin/me', undefined, plainAuth);
  assert(meSuper.data.isSuperAdmin === true, '/me reports SUPER_ADMIN');
  assert(mePlain.data.isSuperAdmin === false, '/me reports plain admin');

  let program = await prisma.program.findUnique({ where: { appCode: MK } });
  if (!program) {
    program = await prisma.program.create({
      data: { appCode: MK, name: 'Müvekkil Kasa Defteri Desktop', productType: 'DESKTOP', defaultLicenseDays: 365, defaultMaxDevices: 1 },
    });
  }

  const stamp = Date.now();
  let seq = 0;
  const createManual = async () => {
    const n = seq++;
    const email = `licdel-${stamp}-${n}@example.invalid`;
    const r = await json(
      'POST',
      '/api/admin/licenses',
      {
        newCustomer: { name: `Silme Test ${n}`, email },
        programId: program!.id,
        licenseDays: 365,
        maxDevices: 1,
        platform: 'WINDOWS',
        notes: `${NOTE_PREFIX}${stamp}-${n}`,
        sendMail: false,
      },
      superAuth
    );
    return { id: r.data.license.id as string, key: r.data.license.licenseKey as string, password: r.data.activationPassword as string, email };
  };
  const del = (id: string, confirmLicenseKey: unknown, auth?: Record<string, string>) =>
    json('DELETE', `/api/admin/licenses/${id}`, { confirmLicenseKey }, auth);

  console.log('-- Yetkilendirme');
  const target = await createManual();
  const noAuth = await del(target.id, target.key);
  assert(noAuth.status === 401, 'unauthenticated delete → 401', String(noAuth.status));
  const plain = await del(target.id, target.key, plainAuth);
  assert(plain.status === 403, 'non-SUPER_ADMIN delete → 403', String(plain.status));
  const stillThere = await prisma.license.findUnique({ where: { id: target.id } });
  assert(stillThere?.deletedAt === null, 'rejected requests leave license untouched');

  console.log('-- Onay');
  const noConfirm = await del(target.id, undefined, superAuth);
  assert(noConfirm.status === 400 && noConfirm.data.code === 'CONFIRMATION_MISMATCH', 'missing confirmation → 400');
  const wrongConfirm = await del(target.id, 'WTG-XXXX-XXXX-XXXX', superAuth);
  assert(wrongConfirm.status === 400, 'wrong license key confirmation → 400');

  console.log('-- Aktif cihaz engeli');
  const deviceHash = `licdel-device-${stamp}`;
  const act = await json('POST', '/api/public/license/activate', {
    licenseKey: target.key,
    activationPassword: target.password,
    appCode: MK,
    deviceHash,
    platform: 'win32-x64',
  });
  assert(act.data.success === true, 'activation before delete succeeds');
  const detailBlocked = await json('GET', `/api/admin/licenses/${target.id}`, undefined, superAuth);
  assert(
    detailBlocked.data.deletionBlockers?.some((b: { code: string }) => b.code === 'ACTIVE_DEVICES'),
    'detail lists ACTIVE_DEVICES blocker'
  );
  const blockedDevice = await del(target.id, target.key, superAuth);
  assert(
    blockedDevice.status === 409 && blockedDevice.data.blockers?.includes('ACTIVE_DEVICES'),
    'license with active device cannot be deleted',
    JSON.stringify(blockedDevice.data)
  );

  console.log('-- Pasife alma değişmedi');
  const disabled = await json('POST', `/api/admin/licenses/${target.id}/disable`, undefined, superAuth);
  assert(disabled.status === 200 && disabled.data.status === LicenseStatus.PASSIVE, 'disable still sets PASSIVE');
  const passiveValidate = await json('POST', '/api/public/license/validate', { licenseKey: target.key, appCode: MK, deviceHash });
  assert(passiveValidate.data.valid === false && passiveValidate.data.status === 'PASSIVE', 'passive license still reports PASSIVE');
  const enabled = await json('POST', `/api/admin/licenses/${target.id}/enable`, undefined, superAuth);
  assert(enabled.status === 200 && enabled.data.status === LicenseStatus.ACTIVE, 'enable still restores ACTIVE');
  const passiveStillListed = await json('GET', '/api/admin/licenses', undefined, superAuth);
  assert(passiveStillListed.data.some((l: { id: string }) => l.id === target.id), 'non-deleted license stays in list');

  console.log('-- Sipariş / ödeme ilişkisi engeli');
  const orderNo = `${NOTE_PREFIX}ORDER-${stamp}`;
  const order = await json(
    'POST',
    '/api/integrations/website/order-license',
    { customerName: 'Sipariş Test', customerEmail: `licdel-order-${stamp}@example.invalid`, appCode: MK, orderNo, licenseDays: 365, platform: 'WINDOWS' },
    integrationHeaders
  );
  const orderLicense = await prisma.license.findUnique({ where: { licenseKey: order.data.licenseKey } });
  const blockedOrder = await del(orderLicense!.id, orderLicense!.licenseKey, superAuth);
  assert(
    blockedOrder.status === 409 && blockedOrder.data.blockers?.includes('ORDER_SOURCE') && blockedOrder.data.blockers?.includes('WEBSITE_ORDER'),
    'website order license cannot be deleted',
    JSON.stringify(blockedOrder.data)
  );

  const renewed = await createManual();
  const renewal = await json(
    'POST',
    '/api/integrations/website/renew-license',
    { orderNo: `${NOTE_PREFIX}RENEW-${stamp}`, licenseKey: renewed.key, appCode: MK, licenseDays: 365 },
    integrationHeaders
  );
  assert(renewal.status === 200, 'manual license renewed by paid order', JSON.stringify(renewal.data));
  const blockedRenewal = await del(renewed.id, renewed.key, superAuth);
  assert(
    blockedRenewal.status === 409 && blockedRenewal.data.blockers?.includes('WEBSITE_RENEWAL'),
    'license with paid renewal cannot be deleted'
  );

  console.log('-- Uygun lisans silinir');
  const victim = await createManual();
  const dashboardBefore = await json('GET', '/api/admin/dashboard', undefined, superAuth);
  const ok = await del(victim.id, ` ${victim.key.toLowerCase()} `, superAuth);
  assert(ok.status === 200 && ok.data.success === true, 'eligible license soft-deleted', JSON.stringify(ok.data));
  const row = await prisma.license.findUnique({ where: { id: victim.id }, include: { events: true } });
  assert(!!row && !!row.deletedAt && row.deletedByEmail === ADMIN_EMAIL, 'row kept with deletedAt and deletedByEmail');
  assert(row?.status === LicenseStatus.ACTIVE, 'status field is not overloaded by delete');
  assert(
    !!row?.events.some((e) => e.eventType === 'LICENSE_CREATED') && !!row?.events.some((e) => e.eventType === 'LICENSE_DELETED'),
    'audit history kept and LICENSE_DELETED logged'
  );

  const list = await json('GET', '/api/admin/licenses', undefined, superAuth);
  assert(!list.data.some((l: { id: string }) => l.id === victim.id), 'deleted license removed from main list');
  const search = await json('GET', `/api/admin/licenses?search=${victim.key}`, undefined, superAuth);
  assert(Array.isArray(search.data) && search.data.length === 0, 'deleted license not found by list search');
  const dashboardAfter = await json('GET', '/api/admin/dashboard', undefined, superAuth);
  assert(dashboardAfter.data.totalLicenses === dashboardBefore.data.totalLicenses - 1, 'dashboard total excludes deleted');
  const detail = await json('GET', `/api/admin/licenses/${victim.id}`, undefined, superAuth);
  assert(detail.status === 200 && !!detail.data.deletedAt, 'detail still readable for audit');

  const deletedAct = await json('POST', '/api/public/license/activate', {
    licenseKey: victim.key,
    activationPassword: victim.password,
    appCode: MK,
    deviceHash: `licdel-after-${stamp}`,
    platform: 'win32-x64',
  });
  assert(deletedAct.data.success === false && deletedAct.data.code === 'LICENSE_DELETED', 'activation blocked after delete');
  const deviceCount = await prisma.licenseDevice.count({ where: { licenseId: victim.id } });
  assert(deviceCount === 0, 'no device row created for deleted license');
  const deletedValidate = await json('POST', '/api/public/license/validate', { licenseKey: victim.key, appCode: MK, deviceHash: `licdel-after-${stamp}` });
  assert(deletedValidate.data.valid === false && deletedValidate.data.code === 'LICENSE_DELETED', 'validation blocked after delete');
  const deletedRenew = await json(
    'POST',
    '/api/integrations/website/renew-license',
    { orderNo: `${NOTE_PREFIX}RENEW-DELETED-${stamp}`, licenseKey: victim.key, appCode: MK, licenseDays: 365 },
    integrationHeaders
  );
  assert(deletedRenew.status === 404, 'renewal of deleted license refused', String(deletedRenew.status));
  const customerLicenses = await json(
    'GET',
    `/api/integrations/website/customer-licenses?email=${encodeURIComponent(victim.email)}`,
    undefined,
    integrationHeaders
  );
  assert(Array.isArray(customerLicenses.data) && customerLicenses.data.length === 0, 'website customer list hides deleted license');

  for (const [label, method, path, body] of [
    ['enable', 'POST', 'enable', undefined],
    ['disable', 'POST', 'disable', undefined],
    ['extend', 'POST', 'extend', { days: 30 }],
    ['reset-devices', 'POST', 'reset-devices', undefined],
    ['regenerate-password', 'POST', 'regenerate-password', undefined],
    ['send-mail', 'POST', 'send-mail', { activationPassword: victim.password }],
  ] as const) {
    const r = await json(method, `/api/admin/licenses/${victim.id}/${path}`, body, superAuth);
    assert(r.status === 409 && r.data.code === 'LICENSE_DELETED', `${label} blocked on deleted license`, String(r.status));
  }
  const patch = await json('PATCH', `/api/admin/licenses/${victim.id}`, { status: 'ACTIVE' }, superAuth);
  assert(patch.status === 409, 'PATCH blocked on deleted license');
  const again = await del(victim.id, victim.key, superAuth);
  assert(again.status === 409 && again.data.code === 'ALREADY_DELETED', 'second delete → 409');
  const missing = await del('00000000-0000-0000-0000-000000000000', 'x', superAuth);
  assert(missing.status === 404, 'unknown license → 404');

  const createdIds = (
    await prisma.license.findMany({
      where: { OR: [{ notes: { startsWith: NOTE_PREFIX } }, { notes: { contains: orderNo } }] },
      select: { id: true },
    })
  ).map((r) => r.id);
  await prisma.websiteLicenseRenewal.deleteMany({ where: { licenseId: { in: createdIds } } });
  await prisma.licenseEvent.deleteMany({ where: { licenseId: { in: createdIds } } });
  await prisma.licenseDevice.deleteMany({ where: { licenseId: { in: createdIds } } });
  await prisma.license.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.customer.deleteMany({ where: { email: { startsWith: `licdel-` } } });
  await prisma.admin.deleteMany({ where: { email: PLAIN_EMAIL } });

  await prisma.$disconnect();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
