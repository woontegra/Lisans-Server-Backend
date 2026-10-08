import assert from 'node:assert/strict';
import {
  assertPassword,
  assertUsername,
  assertSecurityQuestion,
  demoSetupAllowed,
  hashAuthCode,
  maskEmail,
  paidSetupAllowed,
  readDesktopSession,
  signDesktopSession,
} from '../src/services/desktopAuthRules';
import { resetDesktopAuthRateLimit } from '../src/middleware/desktopAuthRateLimit';

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log('ok', name);
  } catch (error) {
    failed += 1;
    console.error('fail', name, error);
  }
}

check('paid setup rejects a second account and a missing device', () => {
  assert.equal(paidSetupAllowed({ appCode: 'BILIRKISI_DESKTOP', deviceActive: true, systemTrial: false, userExists: false }).ok, true);
  const again = paidSetupAllowed({ appCode: 'BILIRKISI_DESKTOP', deviceActive: true, systemTrial: false, userExists: true });
  assert.equal(again.ok, false);
  const missing = paidSetupAllowed({ appCode: 'BILIRKISI_DESKTOP', deviceActive: false, systemTrial: false, userExists: false });
  assert.equal(missing.ok, false);
  const demo = paidSetupAllowed({ appCode: 'BILIRKISI_DESKTOP', deviceActive: true, systemTrial: true, userExists: false });
  assert.equal(demo.ok, false);
});

check('demo setup uses the grant and blocks a second account', () => {
  assert.equal(demoSetupAllowed({ grantActive: true, userExists: false }).ok, true);
  assert.equal(demoSetupAllowed({ grantActive: true, userExists: true }).ok, false);
  assert.equal(demoSetupAllowed({ grantActive: false, userExists: false }).ok, false);
});

check('auth code hash does not keep the raw code and session logout version fails', () => {
  const hash = hashAuthCode('secret', 'ACCOUNT_SETUP', 'lic-1', '123456');
  assert.equal(hash.includes('123456'), false);
  assert.notEqual(hash, hashAuthCode('secret', 'ACCOUNT_SETUP', 'lic-1', '654321'));
  const token = signDesktopSession('secret', 'user-1', 1, 1_000);
  assert.deepEqual(readDesktopSession('secret', token, 1_000), { userId: 'user-1', sessionVersion: 1 });
  assert.equal(readDesktopSession('secret', token, 1_000 + 13 * 60 * 60 * 1000), null);
  const broken = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.equal(readDesktopSession('secret', broken, 1_000), null);
  assert.equal(readDesktopSession('secret', "header.payload.sig", 1_000), null);
});

check('username and password rules reject weak values', () => {
  assert.equal(assertUsername('Ali.01'), 'ali.01');
  assert.equal(assertUsername('info@optimoon.com'), 'info@optimoon.com');
  assert.equal(assertUsername('Hakan Demir'), 'hakan demir');
  assert.throws(() => assertUsername('ab'));
  assert.throws(() => assertUsername('a/b'));
  assert.equal(assertSecurityQuestion('Doğduğunuz şehrin adı nedir?'), 'Doğduğunuz şehrin adı nedir?');
  assert.throws(() => assertSecurityQuestion('En sevdiğiniz yemek nedir?'));
  assert.throws(() => assertPassword('short'));
  assert.equal(assertPassword('uzun-parola'), 'uzun-parola');
});

check('email mask hides the local part', () => {
  assert.equal(maskEmail('Ada@Woontegra.com'), 'a***@woontegra.com');
});

resetDesktopAuthRateLimit();

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('desktop auth unit checks passed');
