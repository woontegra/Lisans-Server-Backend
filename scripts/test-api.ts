/**
 * API integration test script.
 * Run after: prisma db push && npm run seed && npm run dev
 *
 * Usage: npx tsx scripts/test-api.ts
 */

const BASE = process.env.API_BASE || 'http://localhost:4000';

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

async function json(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function main() {
  console.log('\n=== Woontegra Lisans Server API Tests ===\n');

  // Health
  const health = await json('GET', '/health');
  assert(health.status === 200, 'Health check');

  // Login
  const login = await json('POST', '/api/admin/login', {
    email: process.env.ADMIN_EMAIL || 'admin@woontegra.com',
    password: process.env.ADMIN_PASSWORD || 'change-me-strong-password',
  });
  assert(login.status === 200 && login.data.token, 'Admin login');
  const token = login.data.token as string;
  const auth = { Authorization: `Bearer ${token}` };

  // Programs seeded
  const programs = await json('GET', '/api/admin/programs', undefined, auth);
  assert(programs.data.length >= 5, 'Default programs seeded', `count=${programs.data.length}`);

  const mkProgram = programs.data.find((p: { appCode: string }) => p.appCode === 'MUVEKKIL_KASA_DESKTOP');
  assert(!!mkProgram, 'MUVEKKIL_KASA_DESKTOP program exists');

  // Create customer
  const customer = await json('POST', '/api/admin/customers', {
    name: 'Test Müşteri',
    email: `test-${Date.now()}@example.com`,
    phone: '05551234567',
  }, auth);
  assert(customer.status === 201, 'Create customer');

  // Create license
  const license = await json('POST', '/api/admin/licenses', {
    customerId: customer.data.id,
    programId: mkProgram.id,
    licenseDays: 365,
    maxDevices: 1,
  }, auth);
  assert(license.status === 201, 'Create license');
  assert(/^WTG-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(license.data.license.licenseKey), 'License key format');
  assert(!!license.data.activationPassword, 'Activation password returned');

  const licenseKey = license.data.license.licenseKey;
  const activationPassword = license.data.activationPassword;
  const wrongAppCode = 'WRONG_APP_CODE';

  // Wrong appCode
  const wrongApp = await json('POST', '/api/public/license/activate', {
    licenseKey,
    activationPassword,
    appCode: wrongAppCode,
    deviceHash: 'device-hash-1',
    deviceName: 'Test PC',
    platform: 'win32',
    appVersion: '1.0.0',
  });
  assert(wrongApp.data.success === false, 'Wrong appCode rejected');

  // Wrong password
  const wrongPass = await json('POST', '/api/public/license/activate', {
    licenseKey,
    activationPassword: 'wrong-password-xyz',
    appCode: 'MUVEKKIL_KASA_DESKTOP',
    deviceHash: 'device-hash-1',
    deviceName: 'Test PC',
    platform: 'win32',
    appVersion: '1.0.0',
  });
  assert(wrongPass.data.success === false, 'Wrong password rejected');

  // Correct activation
  const activate = await json('POST', '/api/public/license/activate', {
    licenseKey,
    activationPassword,
    appCode: 'MUVEKKIL_KASA_DESKTOP',
    deviceHash: 'device-hash-1',
    deviceName: 'Test PC',
    platform: 'win32',
    appVersion: '1.0.0',
  });
  assert(activate.data.success === true, 'Correct activation succeeds');

  // Device limit
  const overLimit = await json('POST', '/api/public/license/activate', {
    licenseKey,
    activationPassword,
    appCode: 'MUVEKKIL_KASA_DESKTOP',
    deviceHash: 'device-hash-2',
    deviceName: 'Second PC',
    platform: 'win32',
    appVersion: '1.0.0',
  });
  assert(overLimit.data.success === false, 'Device limit enforced');

  // Validate
  const validate = await json('POST', '/api/public/license/validate', {
    licenseKey,
    appCode: 'MUVEKKIL_KASA_DESKTOP',
    deviceHash: 'device-hash-1',
  });
  assert(validate.data.valid === true, 'Validate succeeds');
  assert(validate.data.offlineGraceDays === 7, 'offlineGraceDays is 7');

  // Dashboard
  const dashboard = await json('GET', '/api/admin/dashboard', undefined, auth);
  assert(dashboard.data.totalLicenses >= 1, 'Dashboard stats');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
