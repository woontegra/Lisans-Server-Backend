/**
 * Aktüerya desktop platform + SaaS program tests.
 * Yalnız lokal DATABASE_URL. Production/Railway'e yazmaz.
 */
import http from 'node:http';
import { PrismaClient } from '@prisma/client';
import app from '../src/app';
import { hashPassword } from '../src/utils/password';
import { assertLocalDatabaseUrl } from './assertLocalTestTarget';
import {
  APP_CODE_AKTUERYA_DESKTOP,
  APP_CODE_AKTUERYA_SAAS,
  SAAS_PRODUCT_CODE_AKTUERYA,
  SAAS_TARGET_AKTUERYA,
  SAAS_TARGET_MUVEKKIL_KASA,
} from '../src/constants/aktuerya';

const INTEGRATION_SECRET = process.env.INTEGRATION_SECRET || 'change-me-integration-secret';
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

async function ensureAdmin() {
  const existing = await prisma.admin.findUnique({ where: { email: ADMIN_EMAIL } });
  if (existing) return;
  await prisma.admin.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      name: 'Test Admin',
    },
  });
}

type CapturedProvision = {
  path: string;
  apiKeyMatches: boolean;
  body: Record<string, unknown>;
};

const AKTUERYA_TEST_KEY = 'aktuerya-provision-test-key';

function startAktueryaMock() {
  const calls: CapturedProvision[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      } catch {
        body = {};
      }
      const header = req.headers['x-internal-api-key'];
      const apiKey = Array.isArray(header) ? header[0] : header;
      calls.push({
        path: req.url || '',
        apiKeyMatches: apiKey === AKTUERYA_TEST_KEY,
        body,
      });

      const orderNo = String(body.externalOrderId || '');
      const plan = body.plan === 'yearly' ? 'yearly' : 'monthly';
      if (orderNo.includes('-ERR4-')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            code: 'INVALID_EMAIL',
            message: 'Geçerli customerEmail zorunludur',
            password: 'do-not-store',
            token: 'do-not-store',
          })
        );
        return;
      }
      if (orderNo.includes('-ERR5-')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: 'PROVISION_FAILED', message: 'Provision tamamlanamadı.' }));
        return;
      }

      const result = orderNo.includes('-CONV-') ? 'CONVERTED' : 'CREATED';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          idempotentReplay: false,
          provisionStatus: 'COMPLETED',
          result,
          userId: `user-${orderNo}`,
          subscriptionId: `sub-${orderNo}`,
          plan,
          startsAt: '2026-10-05T12:00:00.000Z',
          expiresAt: plan === 'yearly' ? '2027-10-05T12:00:00.000Z' : '2026-11-05T12:00:00.000Z',
          mailSent: result === 'CREATED',
          apiKey: 'do-not-store',
        })
      );
    });
  });

  return new Promise<{ url: string; calls: CapturedProvision[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () =>
          new Promise((done, reject) => {
            server.close((err) => (err ? reject(err) : done()));
          }),
      });
    });
  });
}

async function ensureProgram(
  auth: Record<string, string>,
  body: Record<string, unknown>
) {
  const created = await json('POST', '/api/admin/programs', body, auth);
  if (created.status === 201) return created;
  const programs = await json('GET', '/api/admin/programs', undefined, auth);
  const found = Array.isArray(programs.data)
    ? programs.data.find((p: { appCode: string }) => p.appCode === body.appCode)
    : null;
  return { status: found ? 200 : created.status, data: found ?? created.data };
}

async function main() {
  console.log('\n=== Aktüerya license tests ===\n');
  assertLocalDatabaseUrl();
  await ensureAdmin();

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
  const auth = { Authorization: `Bearer ${login.data.token as string}` };
  const integrationHeaders = { 'x-integration-secret': INTEGRATION_SECRET };

  const desktop = await ensureProgram(auth, {
    appCode: APP_CODE_AKTUERYA_DESKTOP,
    name: 'Aktüerya Hesaplama Desktop',
    productType: 'DESKTOP',
  });
  assert(desktop.status === 201 || desktop.status === 200, 'AKTUERYA_DESKTOP program', String(desktop.status));

  const bilirkisi = await ensureProgram(auth, {
    appCode: 'BILIRKISI_DESKTOP',
    name: 'Bilirkişi Desktop',
    productType: 'DESKTOP',
  });
  assert(bilirkisi.status === 201 || bilirkisi.status === 200, 'BILIRKISI_DESKTOP program present');

  const stamp = Date.now();
  const windowsOrderNo = `TEST-AKTUERYA-WIN-${stamp}`;
  const windowsEmail = `aktuerya-win-${stamp}@example.invalid`;
  const windowsOrder = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Aktüerya Windows',
      customerEmail: windowsEmail,
      appCode: APP_CODE_AKTUERYA_DESKTOP,
      orderNo: windowsOrderNo,
      platform: 'win32-x64',
      licenseDays: 30,
    },
    integrationHeaders
  );
  assert(windowsOrder.status === 201, 'Windows order 201', String(windowsOrder.status));
  assert(windowsOrder.data.platform === 'WINDOWS', 'License.platform WINDOWS', String(windowsOrder.data.platform));

  const windowsRow = await prisma.license.findFirst({
    where: { notes: `Website sipariş no: ${windowsOrderNo}` },
  });
  assert(windowsRow?.platform === 'WINDOWS', 'DB platform WINDOWS');
  const windowsExpires = windowsRow?.expiresAt.toISOString();

  const windowsReplay = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Aktüerya Windows',
      customerEmail: windowsEmail,
      appCode: APP_CODE_AKTUERYA_DESKTOP,
      orderNo: windowsOrderNo,
      platform: 'WINDOWS',
      licenseDays: 365,
    },
    integrationHeaders
  );
  assert(windowsReplay.status === 409 && windowsReplay.data.alreadyExists === true, 'same orderNo does not create a second license');
  const windowsCount = await prisma.license.count({
    where: { notes: `Website sipariş no: ${windowsOrderNo}` },
  });
  const windowsAfter = await prisma.license.findFirst({
    where: { notes: `Website sipariş no: ${windowsOrderNo}` },
  });
  assert(windowsCount === 1, 'Windows license count stays 1', String(windowsCount));
  assert(windowsAfter?.expiresAt.toISOString() === windowsExpires, 'replay does not extend expiresAt');

  const macOrderNo = `TEST-AKTUERYA-MAC-${stamp}`;
  const macOrder = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Aktüerya macOS',
      customerEmail: `aktuerya-mac-${stamp}@example.invalid`,
      appCode: APP_CODE_AKTUERYA_DESKTOP,
      orderNo: macOrderNo,
      platform: 'darwin',
      licenseDays: 365,
    },
    integrationHeaders
  );
  assert(macOrder.status === 201 && macOrder.data.platform === 'MACOS', 'License.platform MACOS', String(macOrder.data.platform));

  const missingPlatform = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Aktüerya eksik',
      customerEmail: `aktuerya-missing-${stamp}@example.invalid`,
      appCode: APP_CODE_AKTUERYA_DESKTOP,
      orderNo: `TEST-AKTUERYA-MISSING-${stamp}`,
    },
    integrationHeaders
  );
  assert(missingPlatform.status === 400, 'AKTUERYA_DESKTOP without platform is rejected');

  const windowsKey = windowsOrder.data.licenseKey as string;
  const macKey = macOrder.data.licenseKey as string;
  const winOnMac = await json('POST', '/api/public/license/validate', {
    licenseKey: windowsKey,
    appCode: APP_CODE_AKTUERYA_DESKTOP,
    deviceHash: 'aktuerya-device-win',
    platform: 'darwin',
  });
  assert(winOnMac.data.code === 'PLATFORM_MISMATCH', 'Windows license rejected on macOS', String(winOnMac.data.code));

  const macOnWin = await json('POST', '/api/public/license/validate', {
    licenseKey: macKey,
    appCode: APP_CODE_AKTUERYA_DESKTOP,
    deviceHash: 'aktuerya-device-mac',
    platform: 'win32',
  });
  assert(macOnWin.data.code === 'PLATFORM_MISMATCH', 'macOS license rejected on Windows', String(macOnWin.data.code));

  const bhOrderNo = `TEST-AKTUERYA-BH-${stamp}`;
  const bhOrder = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Bilirkişi mevcut',
      customerEmail: `bh-regression-${stamp}@example.invalid`,
      appCode: 'BILIRKISI_DESKTOP',
      orderNo: bhOrderNo,
      platform: 'WINDOWS',
      licenseDays: 365,
    },
    integrationHeaders
  );
  assert(bhOrder.status === 201, 'BILIRKISI_DESKTOP Windows order succeeds', String(bhOrder.status));
  assert(bhOrder.data.platform === 'WINDOWS', 'BILIRKISI_DESKTOP Windows platform stored', String(bhOrder.data.platform));
  const bhOnMac = await json('POST', '/api/public/license/validate', {
    licenseKey: bhOrder.data.licenseKey,
    appCode: 'BILIRKISI_DESKTOP',
    deviceHash: 'bh-device',
    platform: 'darwin',
  });
  assert(bhOnMac.data.code === 'PLATFORM_MISMATCH', 'Bilirkişi Windows license is rejected on macOS');
  const bhMissingPlatform = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Bilirkişi platformsuz',
      customerEmail: `bh-no-platform-${stamp}@example.invalid`,
      appCode: 'BILIRKISI_DESKTOP',
      orderNo: `TEST-AKTUERYA-BH-NOPLAT-${stamp}`,
      licenseDays: 365,
    },
    integrationHeaders
  );
  assert(bhMissingPlatform.status === 400, 'BILIRKISI_DESKTOP order without platform is rejected');

  const badTarget = await json(
    'POST',
    '/api/admin/programs',
    {
      appCode: `TEST_SAAS_OTHER_${stamp}`,
      name: 'Other SaaS',
      productType: 'SAAS',
      targetService: 'OTHER',
      saasProductCode: 'OTHER',
    },
    auth
  );
  assert(badTarget.status === 400, 'unknown SAAS target rejected');

  const badCode = await json(
    'POST',
    '/api/admin/programs',
    {
      appCode: `TEST_AKTUERYA_BAD_CODE_${stamp}`,
      name: 'Aktüerya bad code',
      productType: 'SAAS',
      targetService: SAAS_TARGET_AKTUERYA,
      saasProductCode: 'AKTUERYA_OTHER',
    },
    auth
  );
  assert(badCode.status === 400, 'AKTUERYA requires saasProductCode AKTUERYA_SAAS');

  const saasProgram = await ensureProgram(auth, {
    appCode: APP_CODE_AKTUERYA_SAAS,
    name: 'Aktüerya Hesaplama SaaS',
    productType: 'SAAS',
    targetService: 'aktuerya',
    saasProductCode: SAAS_PRODUCT_CODE_AKTUERYA,
  });
  assert(saasProgram.status === 201 || saasProgram.status === 200, 'AKTUERYA_SAAS program accepted', String(saasProgram.status));
  assert(saasProgram.data?.productType === 'SAAS', 'AKTUERYA_SAAS productType SAAS', String(saasProgram.data?.productType));
  assert(saasProgram.data?.targetService === SAAS_TARGET_AKTUERYA, 'targetService AKTUERYA', String(saasProgram.data?.targetService));

  const previousAktueryaUrl = process.env.SAAS_PROVIDER_AKTUERYA_URL;
  const previousAktueryaKey = process.env.SAAS_PROVIDER_AKTUERYA_API_KEY;
  delete process.env.SAAS_PROVIDER_AKTUERYA_URL;
  delete process.env.SAAS_PROVIDER_AKTUERYA_API_KEY;

  const missingPlanNo = `TEST-AKTUERYA-NOPLAN-${stamp}`;
  const missingPlan = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Aktüerya SaaS',
      customerEmail: `aktuerya-noplan-${stamp}@example.invalid`,
      appCode: APP_CODE_AKTUERYA_SAAS,
      orderNo: missingPlanNo,
      licenseDays: 365,
    },
    integrationHeaders
  );
  assert(missingPlan.status === 400, 'AKTUERYA_SAAS without plan is rejected', String(missingPlan.status));
  assert(missingPlan.data.code === 'AKTUERYA_PLAN_REQUIRED', 'plan is required and not inferred from licenseDays');
  const missingPlanLicense = await prisma.license.findFirst({
    where: { notes: `Website sipariş no: ${missingPlanNo}` },
  });
  assert(!missingPlanLicense, 'missing plan does not create a license');

  const badPaidAt = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Aktüerya SaaS',
      customerEmail: `aktuerya-paidat-${stamp}@example.invalid`,
      appCode: APP_CODE_AKTUERYA_SAAS,
      orderNo: `TEST-AKTUERYA-PAIDAT-${stamp}`,
      plan: 'monthly',
      paidAt: 'not-a-date',
    },
    integrationHeaders
  );
  assert(badPaidAt.status === 400 && badPaidAt.data.code === 'INVALID_PAID_AT', 'invalid paidAt rejected');

  const unconfiguredNo = `TEST-AKTUERYA-NOCFG-${stamp}`;
  const unconfiguredEmail = `aktuerya-nocfg-${stamp}@example.invalid`;
  const unconfigured = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Aktüerya SaaS',
      customerEmail: unconfiguredEmail,
      customerPhone: '05550000000',
      appCode: APP_CODE_AKTUERYA_SAAS,
      orderNo: unconfiguredNo,
      plan: 'yearly',
      licenseDays: 30,
    },
    integrationHeaders
  );
  assert(unconfigured.status === 501, 'AKTUERYA without provider is 501', String(unconfigured.status));
  assert(unconfigured.data.code === 'SAAS_PROVIDER_NOT_CONFIGURED', 'missing provider config', String(unconfigured.data.code));
  assert(unconfigured.data.provisionStatus === 'FAILED', 'missing provider marks FAILED');
  const unconfiguredLicense = await prisma.license.findFirst({
    where: { notes: `Website sipariş no: ${unconfiguredNo}` },
  });
  const unconfiguredExpires = unconfiguredLicense?.expiresAt.toISOString();
  const unconfiguredDelivery = await prisma.saasDelivery.findUnique({ where: { externalOrderId: unconfiguredNo } });
  assert(!!unconfiguredLicense, 'license still created when provider config is missing');
  assert(unconfiguredDelivery?.provisionStatus === 'FAILED', 'SaasDelivery FAILED without provider');
  assert(unconfiguredDelivery?.provisionError === 'SAAS_PROVIDER_NOT_CONFIGURED', 'provider error stored');
  assert(unconfiguredDelivery?.licenseId === unconfiguredLicense?.id, 'delivery linked without provider');

  process.env.SAAS_PROVIDER_AKTUERYA_URL = 'http://127.0.0.1:9';
  delete process.env.SAAS_PROVIDER_AKTUERYA_API_KEY;
  const missingKey = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Aktüerya SaaS',
      customerEmail: `aktuerya-nokey-${stamp}@example.invalid`,
      appCode: APP_CODE_AKTUERYA_SAAS,
      orderNo: `TEST-AKTUERYA-NOKEY-${stamp}`,
      plan: 'monthly',
    },
    integrationHeaders
  );
  assert(missingKey.data.code === 'SAAS_PROVIDER_NOT_CONFIGURED', 'URL without API key is not configured');
  delete process.env.SAAS_PROVIDER_AKTUERYA_URL;

  const unconfiguredReplay = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Aktüerya SaaS',
      customerEmail: unconfiguredEmail,
      appCode: APP_CODE_AKTUERYA_SAAS,
      orderNo: unconfiguredNo,
      plan: 'monthly',
      licenseDays: 365,
    },
    integrationHeaders
  );
  assert(unconfiguredReplay.status === 501, 'unconfigured replay stays failed');
  const unconfiguredCount = await prisma.license.count({
    where: { notes: `Website sipariş no: ${unconfiguredNo}` },
  });
  const unconfiguredAfter = await prisma.license.findFirst({
    where: { notes: `Website sipariş no: ${unconfiguredNo}` },
  });
  assert(unconfiguredCount === 1, 'unconfigured replay does not create a second license', String(unconfiguredCount));
  assert(unconfiguredAfter?.expiresAt.toISOString() === unconfiguredExpires, 'unconfigured replay does not extend the license');

  const mock = await startAktueryaMock();
  process.env.SAAS_PROVIDER_AKTUERYA_URL = mock.url;
  process.env.SAAS_PROVIDER_AKTUERYA_API_KEY = AKTUERYA_TEST_KEY;

  const monthlyNo = `TEST-AKTUERYA-MONTH-${stamp}`;
  const monthlyPaidAt = '2026-10-05T08:30:00.000Z';
  const monthly = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Aylık Müşteri',
      customerEmail: `aktuerya-month-${stamp}@example.invalid`,
      customerPhone: '05551112233',
      appCode: APP_CODE_AKTUERYA_SAAS,
      orderNo: monthlyNo,
      plan: 'monthly',
      paidAt: monthlyPaidAt,
      licenseDays: 365,
    },
    integrationHeaders
  );
  assert(monthly.status === 201 && monthly.data.provisionStatus === 'SUCCESS', 'monthly provision SUCCESS', String(monthly.status));
  assert(monthly.data.provisionResult === 'CREATED', 'monthly result CREATED');
  assert(monthly.data.aktueryaUserId === `user-${monthlyNo}`, 'monthly user id returned');
  assert(monthly.data.aktueryaSubscriptionId === `sub-${monthlyNo}`, 'monthly subscription id returned');
  const monthlyCall = mock.calls.filter((call) => call.body.externalOrderId === monthlyNo);
  assert(monthlyCall.length === 1 && monthlyCall[0]?.path === '/internal/license/saas-provision', 'monthly calls Aktüerya once');
  assert(monthlyCall[0]?.apiKeyMatches === true, 'monthly sends the shared API key header');
  assert(monthlyCall[0]?.body.plan === 'monthly', 'monthly plan is sent as monthly');
  assert(monthlyCall[0]?.body.productCode === 'AKTUERYA_SAAS', 'productCode AKTUERYA_SAAS');
  assert(monthlyCall[0]?.body.paidAt === monthlyPaidAt, 'paidAt is forwarded');
  assert(monthlyCall[0]?.body.customerEmail === `aktuerya-month-${stamp}@example.invalid`, 'customerEmail forwarded');
  assert(monthlyCall[0]?.body.customerPhone === '05551112233', 'customerPhone forwarded');
  const monthlyDelivery = await prisma.saasDelivery.findUnique({ where: { externalOrderId: monthlyNo } });
  const monthlyLicense = await prisma.license.findFirst({ where: { notes: `Website sipariş no: ${monthlyNo}` } });
  const monthlyExpires = monthlyLicense?.expiresAt.toISOString();
  assert(monthlyDelivery?.provisionStatus === 'SUCCESS', 'monthly SaasDelivery SUCCESS');
  assert(monthlyDelivery?.licenseId === monthlyLicense?.id, 'monthly delivery linked to the central license');
  const monthlyRaw = JSON.stringify(monthlyDelivery?.rawResponse ?? {});
  assert(monthlyRaw.includes(`user-${monthlyNo}`) && monthlyRaw.includes(`sub-${monthlyNo}`), 'userId and subscriptionId stored');
  assert(!monthlyRaw.includes('do-not-store'), 'provider secret fields are not stored');

  const yearlyNo = `TEST-AKTUERYA-YEAR-${stamp}`;
  const yearly = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Yıllık Müşteri',
      customerEmail: `aktuerya-year-${stamp}@example.invalid`,
      appCode: APP_CODE_AKTUERYA_SAAS,
      orderNo: yearlyNo,
      plan: 'yearly',
      licenseDays: 30,
    },
    integrationHeaders
  );
  assert(yearly.status === 201 && yearly.data.provisionStatus === 'SUCCESS', 'yearly provision SUCCESS', String(yearly.status));
  assert(yearly.data.subscriptionExpiresAt === '2027-10-05T12:00:00.000Z', 'yearly subscription end stored');
  const yearlyCall = mock.calls.find((call) => call.body.externalOrderId === yearlyNo);
  assert(yearlyCall?.body.plan === 'yearly', 'licenseDays 30 does not override yearly plan');

  const convertedNo = `TEST-AKTUERYA-CONV-${stamp}`;
  const converted = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Demo Dönüşüm',
      customerEmail: `aktuerya-conv-${stamp}@example.invalid`,
      appCode: APP_CODE_AKTUERYA_SAAS,
      orderNo: convertedNo,
      plan: 'monthly',
    },
    integrationHeaders
  );
  assert(converted.status === 201 && converted.data.provisionStatus === 'SUCCESS', 'demo conversion response SUCCESS');
  assert(converted.data.provisionResult === 'CONVERTED', 'CONVERTED result kept');
  const convertedDelivery = await prisma.saasDelivery.findUnique({ where: { externalOrderId: convertedNo } });
  assert(convertedDelivery?.provisionStatus === 'SUCCESS', 'CONVERTED delivery SUCCESS');
  assert(
    typeof convertedDelivery?.rawResponse === 'object' &&
      convertedDelivery?.rawResponse !== null &&
      (convertedDelivery.rawResponse as { result?: string }).result === 'CONVERTED',
    'CONVERTED stored on SaasDelivery'
  );

  const err4No = `TEST-AKTUERYA-ERR4-${stamp}`;
  const err4 = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Hatalı E-posta',
      customerEmail: `aktuerya-err4-${stamp}@example.invalid`,
      appCode: APP_CODE_AKTUERYA_SAAS,
      orderNo: err4No,
      plan: 'monthly',
    },
    integrationHeaders
  );
  assert(err4.status === 501 && err4.data.code === 'INVALID_EMAIL', 'provider 4xx code reflected', String(err4.data.code));
  const err4Delivery = await prisma.saasDelivery.findUnique({ where: { externalOrderId: err4No } });
  const err4Raw = JSON.stringify(err4Delivery?.rawResponse ?? {});
  assert(err4Delivery?.provisionStatus === 'FAILED', '4xx delivery FAILED');
  assert(err4Delivery?.provisionError === 'INVALID_EMAIL', '4xx error code stored');
  assert(!err4Raw.includes('do-not-store') && !err4Raw.toLowerCase().includes('password'), '4xx secret fields dropped');

  const err5No = `TEST-AKTUERYA-ERR5-${stamp}`;
  const err5 = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Sunucu Hatası',
      customerEmail: `aktuerya-err5-${stamp}@example.invalid`,
      appCode: APP_CODE_AKTUERYA_SAAS,
      orderNo: err5No,
      plan: 'yearly',
    },
    integrationHeaders
  );
  assert(err5.status === 501 && err5.data.code === 'PROVISION_FAILED', 'provider 5xx code reflected', String(err5.data.code));
  const err5Delivery = await prisma.saasDelivery.findUnique({ where: { externalOrderId: err5No } });
  assert(err5Delivery?.provisionStatus === 'FAILED' && err5Delivery.provisionError === 'PROVISION_FAILED', '5xx delivery FAILED');
  const err5LicenseCount = await prisma.license.count({ where: { notes: `Website sipariş no: ${err5No}` } });
  assert(err5LicenseCount === 1, '5xx still keeps a single central license', String(err5LicenseCount));

  const monthlyReplay = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Aylık Müşteri',
      customerEmail: `aktuerya-month-${stamp}@example.invalid`,
      appCode: APP_CODE_AKTUERYA_SAAS,
      orderNo: monthlyNo,
      plan: 'yearly',
      licenseDays: 30,
    },
    integrationHeaders
  );
  assert(monthlyReplay.status === 200 && monthlyReplay.data.alreadyExists === true, 'successful order replay is idempotent');
  assert(monthlyReplay.data.provisionStatus === 'SUCCESS', 'replay stays SUCCESS');
  assert(monthlyReplay.data.provisionResult === 'CREATED', 'replay does not reclassify the provision');
  const monthlyCallsAfter = mock.calls.filter((call) => call.body.externalOrderId === monthlyNo).length;
  assert(monthlyCallsAfter === 1, 'replay does not call Aktüerya again', String(monthlyCallsAfter));
  const monthlyLicenseCount = await prisma.license.count({ where: { notes: `Website sipariş no: ${monthlyNo}` } });
  const monthlyAfter = await prisma.license.findFirst({ where: { notes: `Website sipariş no: ${monthlyNo}` } });
  const monthlyDeliveryCount = await prisma.saasDelivery.count({ where: { externalOrderId: monthlyNo } });
  assert(monthlyLicenseCount === 1, 'replay does not create a second license', String(monthlyLicenseCount));
  assert(monthlyDeliveryCount === 1, 'replay does not create a second SaasDelivery', String(monthlyDeliveryCount));
  assert(monthlyAfter?.expiresAt.toISOString() === monthlyExpires, 'replay does not extend the central license');

  await mock.close();
  if (previousAktueryaUrl === undefined) delete process.env.SAAS_PROVIDER_AKTUERYA_URL;
  else process.env.SAAS_PROVIDER_AKTUERYA_URL = previousAktueryaUrl;
  if (previousAktueryaKey === undefined) delete process.env.SAAS_PROVIDER_AKTUERYA_API_KEY;
  else process.env.SAAS_PROVIDER_AKTUERYA_API_KEY = previousAktueryaKey;

  const mkProgram = await ensureProgram(auth, {
    appCode: 'MUVEKKIL_KASA_SAAS',
    name: 'Müvekkil Kasa Defteri SaaS',
    productType: 'SAAS',
    targetService: SAAS_TARGET_MUVEKKIL_KASA,
    saasProductCode: 'MUVEKKIL_KASA_SAAS',
  });
  assert(mkProgram.status === 201 || mkProgram.status === 200, 'MUVEKKIL_KASA_SAAS program still accepted');
  assert(mkProgram.data?.productType === 'SAAS', 'MUVEKKIL_KASA_SAAS stays SAAS');

  const hasProvider = !!(
    process.env.SAAS_PROVIDER_MUVEKKIL_KASA_URL?.trim() &&
    process.env.SAAS_PROVIDER_MUVEKKIL_KASA_API_KEY?.trim()
  );
  if (!hasProvider) {
    const mkOrderNo = `TEST-AKTUERYA-MK-${stamp}`;
    const mkOrder = await json(
      'POST',
      '/api/integrations/website/order-license',
      {
        customerName: 'MK regression',
        customerEmail: `mk-regression-${stamp}@example.invalid`,
        appCode: 'MUVEKKIL_KASA_SAAS',
        orderNo: mkOrderNo,
        licenseDays: 365,
        plan: 'monthly',
      },
      integrationHeaders
    );
    assert(mkOrder.status === 501, 'MK without provider still 501');
    assert(mkOrder.data.code === 'SAAS_PROVIDER_NOT_CONFIGURED', 'MK still uses provider config', String(mkOrder.data.code));
    const mkDelivery = await prisma.saasDelivery.findUnique({ where: { externalOrderId: mkOrderNo } });
    assert(mkDelivery?.provisionStatus === 'FAILED', 'MK delivery remains FAILED when provider is missing', mkDelivery?.provisionStatus);
  } else {
    console.log('  ~ MK live provider env present; order call skipped');
  }

  await prisma.saasDelivery.deleteMany({
    where: { externalOrderId: { startsWith: 'TEST-AKTUERYA-' } },
  });
  await prisma.license.deleteMany({
    where: { notes: { contains: 'TEST-AKTUERYA-' } },
  });

  await prisma.$disconnect();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
