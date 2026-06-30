/**
 * P0 SaaS product type + desktop regression tests.
 * Usage: npx tsx scripts/test-p0-saas.ts
 */
import app from '../src/app';
import { PrismaClient } from '@prisma/client';

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

const DESKTOP_APP_CODES = [
  'BILIRKISI_DESKTOP',
  'ISLETME_DEFTERI_DESKTOP',
  'MUVEKKIL_KASA_DESKTOP',
  'OPTIK_DESKTOP',
  'SIFRE_KASASI_DESKTOP',
];

async function main() {
  console.log('\n=== P0 SaaS + Desktop Regression Tests ===\n');

  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  BASE = `http://127.0.0.1:${port}`;

  const health = await json('GET', '/health');
  assert(health.status === 200, 'Health check');

  const login = await json('POST', '/api/admin/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  assert(login.status === 200 && login.data.token, 'Admin login');
  const auth = { Authorization: `Bearer ${login.data.token as string}` };
  const integrationHeaders = { 'x-integration-secret': INTEGRATION_SECRET };

  const programs = await json('GET', '/api/admin/programs', undefined, auth);
  assert(Array.isArray(programs.data), 'List programs');

  for (const code of DESKTOP_APP_CODES) {
    const p = programs.data.find((x: { appCode: string }) => x.appCode === code);
    if (p) {
      assert(p.productType === 'DESKTOP' || p.productType === undefined, `${code} is DESKTOP`, String(p.productType));
    } else {
      console.log(`  ~ ${code} not in DB (skip)`);
    }
  }

  let desktopProgram = programs.data.find(
    (p: { appCode: string }) => p.appCode === 'TEST_DYNAMIC_DESKTOP'
  );
  if (!desktopProgram) {
    desktopProgram = programs.data.find(
      (p: { productType?: string }) => (p.productType ?? 'DESKTOP') === 'DESKTOP'
    );
  }
  assert(!!desktopProgram, 'Desktop program for order-license test');

  const desktopOrderNo = `TEST-DESKTOP-P0-${Date.now()}`;
  const desktopOrder = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Desktop P0 Test',
      customerEmail: `desktop-p0-${Date.now()}@example.invalid`,
      customerPhone: '05551234567',
      appCode: desktopProgram.appCode,
      orderNo: desktopOrderNo,
      licenseDays: 365,
      maxDevices: 1,
    },
    integrationHeaders
  );
  assert(desktopOrder.status === 201 && desktopOrder.data.success === true, 'Desktop order-license 201');
  assert(!!desktopOrder.data.licenseKey, 'Desktop licenseKey produced');
  assert(!!desktopOrder.data.activationPassword, 'Desktop activationPassword produced');

  const licenseKey = desktopOrder.data.licenseKey as string;
  const activationPassword = desktopOrder.data.activationPassword as string;
  const appCode = desktopProgram.appCode as string;

  const wrongApp = await json('POST', '/api/public/license/activate', {
    licenseKey,
    activationPassword,
    appCode: 'WRONG_APP',
    deviceHash: 'p0-device-1',
  });
  assert(wrongApp.data.success === false, 'Wrong appCode rejected');

  const activate = await json('POST', '/api/public/license/activate', {
    licenseKey,
    activationPassword,
    appCode,
    deviceHash: 'p0-device-1',
    deviceName: 'P0 Test PC',
  });
  assert(activate.data.success === true, 'Activate succeeds');

  const validate = await json('POST', '/api/public/license/validate', {
    licenseKey,
    appCode,
    deviceHash: 'p0-device-1',
  });
  assert(validate.data.valid === true, 'Validate succeeds');

  const saasAppCode = 'MUVEKKIL_KASA_SAAS';
  let saasProgram = programs.data.find((p: { appCode: string }) => p.appCode === saasAppCode);
  if (!saasProgram) {
    const created = await json(
      'POST',
      '/api/admin/programs',
      {
        appCode: saasAppCode,
        name: 'Müvekkil Kasa Defteri SaaS',
        productType: 'SAAS',
        targetService: 'MUVEKKIL_KASA',
        saasProductCode: 'MUVEKKIL_KASA_SAAS',
        defaultLicenseDays: 365,
      },
      auth
    );
    assert(created.status === 201, 'Create MUVEKKIL_KASA_SAAS program', JSON.stringify(created.data));
    saasProgram = created.data;
  } else {
    assert(saasProgram.productType === 'SAAS', 'MUVEKKIL_KASA_SAAS productType SAAS');
  }

  const saasOrderNo = `TEST-SAAS-P0-${Date.now()}`;
  const saasOrder = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'SaaS P0 Test',
      customerEmail: `saas-p0-${Date.now()}@example.invalid`,
      appCode: saasAppCode,
      orderNo: saasOrderNo,
      licenseDays: 365,
    },
    integrationHeaders
  );
  const hasProvider = !!(
    process.env.SAAS_PROVIDER_MUVEKKIL_KASA_URL?.trim() &&
    process.env.SAAS_PROVIDER_MUVEKKIL_KASA_API_KEY?.trim()
  );
  if (hasProvider) {
    assert(
      saasOrder.status === 201 || saasOrder.status === 200,
      'SaaS order-license success when provider configured',
      String(saasOrder.status)
    );
    assert(saasOrder.data.deliveryType === 'SAAS', 'SaaS deliveryType');
    assert(!!saasOrder.data.licenseKey, 'SaaS licenseKey created');
    assert(!saasOrder.data.activationPassword, 'SaaS no activationPassword');
    assert(saasOrder.data.provisionStatus === 'SUCCESS', 'SaaS provision SUCCESS');
  } else {
    assert(saasOrder.status === 501, 'SaaS order-license returns 501 without provider', String(saasOrder.status));
    assert(saasOrder.data.deliveryType === 'SAAS', 'SaaS deliveryType');
    assert(!!saasOrder.data.licenseKey, 'SaaS licenseKey created even when provision fails');
    assert(
      saasOrder.data.code === 'SAAS_PROVIDER_NOT_CONFIGURED',
      'SaaS provider not configured',
      String(saasOrder.data.code)
    );
    assert(!saasOrder.data.activationPassword, 'SaaS no activationPassword');
  }

  const delivery = await prisma.saasDelivery.findUnique({
    where: { externalOrderId: saasOrderNo },
  });
  const saasLicense = await prisma.license.findFirst({
    where: { notes: `Website sipariş no: ${saasOrderNo}` },
  });
  assert(!!saasLicense, 'License record exists for SaaS order');
  assert(!!delivery, 'SaasDelivery record exists');
  assert(delivery?.licenseId === saasLicense?.id, 'SaasDelivery linked to license');
  assert(
    delivery?.provisionStatus === (hasProvider ? 'SUCCESS' : 'FAILED'),
    hasProvider ? 'SaasDelivery SUCCESS' : 'SaasDelivery FAILED',
    delivery?.provisionStatus ?? ''
  );

  await prisma.saasDelivery.deleteMany({
    where: { externalOrderId: { startsWith: 'TEST-SAAS-P0-' } },
  });
  await prisma.license.deleteMany({
    where: { notes: { contains: 'TEST-DESKTOP-P0-' } },
  });

  await prisma.$disconnect();

  await new Promise<void>((resolve, reject) => {
    server.close((e) => (e ? reject(e) : resolve()));
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
