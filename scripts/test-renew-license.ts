/**
 * Masaüstü lisans yenileme (renew-license + desktop-renewal/open) hedefli testler.
 * Çalıştır: npm run test:renew-license
 *
 * Gereksinim: DATABASE_URL + migrate/push uygulanmış WebsiteLicenseRenewal tablosu.
 */
import assert from 'node:assert/strict';
import app from '../src/app';
import { PrismaClient } from '@prisma/client';
import {
  addDaysFromBase,
  computeExtensionBaseDate,
  dayStart,
} from '../src/services/websiteRenewalService';

const INTEGRATION_SECRET = process.env.INTEGRATION_SECRET || 'change-me-integration-secret';

const prisma = new PrismaClient();

let BASE = '';

async function json(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main() {
  console.log('\n=== renew-license integration tests ===\n');

  // Saf tarih kuralı (website ile uyum)
  {
    const activeEnd = new Date(2027, 5, 21, 12, 0, 0);
    const ref = new Date(2026, 7, 10, 12, 0, 0);
    const base = computeExtensionBaseDate(activeEnd, ref);
    assert.equal(localYmd(base), '2027-06-21');
    const next = addDaysFromBase(base, 365);
    assert.equal(localYmd(next), '2028-06-20');
    const expiredEnd = new Date(2026, 0, 1, 12, 0, 0);
    const expiredBase = computeExtensionBaseDate(expiredEnd, ref);
    assert.equal(localYmd(expiredBase), '2026-08-10');
    console.log('  ✓ date rules (unit)');
  }

  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  BASE = `http://127.0.0.1:${port}`;

  const integrationHeaders = { 'x-integration-secret': INTEGRATION_SECRET };

  const programs = await json(
    'GET',
    '/api/integrations/website/programs?activeOnly=true',
    undefined,
    integrationHeaders,
  );
  assert.ok(Array.isArray(programs.data), 'list programs via integration');

  let desktopProgram = programs.data.find(
    (p: { appCode: string }) => p.appCode === 'MUVEKKIL_KASA_DESKTOP',
  );
  if (!desktopProgram) {
    desktopProgram = programs.data.find(
      (p: { productType?: string }) => (p.productType ?? 'DESKTOP') === 'DESKTOP',
    );
  }
  assert.ok(desktopProgram, 'desktop program exists');

  const appCode = desktopProgram.appCode as string;
  const purchaseOrderNo = `TEST-RENEW-PURCHASE-${Date.now()}`;
  const purchase = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Renew Test',
      customerEmail: `renew-test-${Date.now()}@example.invalid`,
      appCode,
      orderNo: purchaseOrderNo,
      licenseDays: 30,
      maxDevices: 1,
    },
    integrationHeaders,
  );
  assert.equal(purchase.status, 201);
  const licenseKey = purchase.data.licenseKey as string;
  const activationPassword = purchase.data.activationPassword as string;
  const deviceHash = `renew-device-${Date.now()}`;

  await json(
    'POST',
    '/api/public/license/activate',
    { licenseKey, activationPassword, appCode, deviceHash },
  );

  const licenseBefore = await prisma.license.findUnique({ where: { licenseKey } });
  assert.ok(licenseBefore);
  const activePrev = new Date(licenseBefore!.expiresAt);

  // D) wrong secret
  {
    const bad = await json(
      'POST',
      '/api/integrations/website/renew-license',
      { orderNo: 'X', licenseKey, appCode, licenseDays: 365 },
      { 'x-integration-secret': 'wrong-secret' },
    );
    assert.equal(bad.status, 403);
    console.log('  ✓ D) wrong secret rejected');
  }

  // E) wrong appCode
  {
    const bad = await json(
      'POST',
      '/api/integrations/website/renew-license',
      {
        orderNo: `TEST-RENEW-BADAPP-${Date.now()}`,
        licenseKey,
        appCode: 'WRONG_APP_CODE',
        licenseDays: 365,
      },
      integrationHeaders,
    );
    assert.equal(bad.status, 400);
    console.log('  ✓ E) wrong appCode rejected');
  }

  // F) missing license
  {
    const bad = await json(
      'POST',
      '/api/integrations/website/renew-license',
      {
        orderNo: `TEST-RENEW-NOLIC-${Date.now()}`,
        licenseKey: 'WTG-XXXX-XXXX-XXXX',
        appCode,
        licenseDays: 365,
      },
      integrationHeaders,
    );
    assert.equal(bad.status, 404);
    console.log('  ✓ F) missing licenseKey rejected');
  }

  // A) active license + 365 days
  const renewOrderNo = `TEST-RENEW-ACTIVE-${Date.now()}`;
  const renew1 = await json(
    'POST',
    '/api/integrations/website/renew-license',
    { orderNo: renewOrderNo, licenseKey, appCode, licenseDays: 365 },
    integrationHeaders,
  );
  assert.equal(renew1.status, 200);
  assert.equal(renew1.data.success, true);
  assert.equal(renew1.data.alreadyRenewed, false);
  assert.equal(renew1.data.licenseKey, licenseKey);
  assert.ok(renew1.data.previousExpiresAt);
  assert.ok(renew1.data.newExpiresAt);

  const afterActive = await prisma.license.findUnique({ where: { licenseKey } });
  assert.ok(afterActive);
  const expectedActiveEnd = addDaysFromBase(computeExtensionBaseDate(activePrev), 365);
  assert.equal(
    afterActive!.expiresAt.toISOString(),
    expectedActiveEnd.toISOString(),
    'active license extended from current end',
  );
  console.log('  ✓ A) active license +365 days');

  // C) same orderNo twice
  const renew2 = await json(
    'POST',
    '/api/integrations/website/renew-license',
    { orderNo: renewOrderNo, licenseKey, appCode, licenseDays: 365 },
    integrationHeaders,
  );
  assert.equal(renew2.status, 200);
  assert.equal(renew2.data.alreadyRenewed, true);
  assert.equal(renew2.data.licenseKey, licenseKey);
  const afterDup = await prisma.license.findUnique({ where: { licenseKey } });
  assert.equal(afterDup!.expiresAt.toISOString(), afterActive!.expiresAt.toISOString());
  console.log('  ✓ C) duplicate orderNo idempotent');

  // G) license key unchanged
  assert.equal(afterDup!.licenseKey, licenseKey);
  console.log('  ✓ G) license key unchanged');

  // H) contract fields for website fulfillment
  assert.ok(typeof renew1.data.previousExpiresAt === 'string');
  assert.ok(typeof renew1.data.newExpiresAt === 'string');
  console.log('  ✓ H) website fulfillment contract');

  // desktop-renewal/open
  const open = await json(
    'POST',
    '/api/integrations/website/desktop-renewal/open',
    { licenseKey, deviceHash, appCode },
    integrationHeaders,
  );
  assert.equal(open.status, 200);
  assert.equal(open.data.licenseId, afterDup!.id);
  assert.ok(open.data.customerName);
  assert.equal(open.data.customerNumber ?? null, null);
  assert.ok(open.data.expiresAt);
  console.log('  ✓ desktop-renewal/open');

  // B) expired license + 365 from today
  const expiredOrderNo = `TEST-RENEW-EXPIRED-${Date.now()}`;
  const expiredPurchaseNo = `TEST-RENEW-EXPIRED-PUR-${Date.now()}`;
  const expiredPurchase = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Expired Renew',
      customerEmail: `expired-renew-${Date.now()}@example.invalid`,
      appCode,
      orderNo: expiredPurchaseNo,
      licenseDays: 7,
    },
    integrationHeaders,
  );
  const expiredKey = expiredPurchase.data.licenseKey as string;
  const expiredPass = expiredPurchase.data.activationPassword as string;
  const expiredDevice = `expired-device-${Date.now()}`;
  await json('POST', '/api/public/license/activate', {
    licenseKey: expiredKey,
    activationPassword: expiredPass,
    appCode,
    deviceHash: expiredDevice,
  });

  const past = new Date();
  past.setDate(past.getDate() - 30);
  await prisma.license.update({
    where: { licenseKey: expiredKey },
    data: { expiresAt: past, status: 'EXPIRED' },
  });

  const renewExpired = await json(
    'POST',
    '/api/integrations/website/renew-license',
    { orderNo: expiredOrderNo, licenseKey: expiredKey, appCode, licenseDays: 365 },
    integrationHeaders,
  );
  assert.equal(renewExpired.status, 200);
  const expiredLic = await prisma.license.findUnique({ where: { licenseKey: expiredKey } });
  assert.ok(expiredLic);
  const expectedExpiredEnd = addDaysFromBase(dayStart(new Date()), 365);
  assert.equal(
    localYmd(expiredLic!.expiresAt),
    localYmd(expectedExpiredEnd),
    'expired license extended from today',
  );
  console.log('  ✓ B) expired license +365 from today');

  // cleanup
  await prisma.websiteLicenseRenewal.deleteMany({
    where: {
      externalOrderId: {
        in: [renewOrderNo, expiredOrderNo],
      },
    },
  });
  await prisma.license.deleteMany({
    where: {
      licenseKey: { in: [licenseKey, expiredKey] },
    },
  });

  await prisma.$disconnect();
  await new Promise<void>((resolve, reject) => {
    server.close((e) => (e ? reject(e) : resolve()));
  });

  console.log('\n[test:renew-license] all tests passed\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
