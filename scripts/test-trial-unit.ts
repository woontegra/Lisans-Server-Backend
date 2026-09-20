import {
  APP_CODE_KOOPPLUS_DESKTOP,
  APP_CODE_MUVEKKIL_KASA_DESKTOP,
  AUTO_TRIAL_APP_CODES,
  DESKTOP_TRIAL_DAYS,
  DESKTOP_TRIAL_OFFLINE_GRACE_DAYS,
  DEVICE_HASH_SHA256_HEX,
  KOOPPLUS_PROGRAM_DEFAULTS,
  MUVEKKIL_KASA_PROGRAM_DEFAULTS,
  SYSTEM_TRIAL_CUSTOMER_EMAIL,
  SYSTEM_TRIAL_NOTES_PREFIX,
  TRIAL_ERROR_CODES,
  getDesktopTrialProgramConfig,
  isSystemTrialLicenseNotes,
} from '../src/constants/desktopTrial';
import { config } from '../src/config';
import { DesktopTrialError, startDesktopTrial } from '../src/services/desktopTrialService';
import { normalizeTrialEmail, normalizeTurkishMobile } from '../src/lib/trialContact';

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

async function expectCode(fn: () => Promise<unknown>, code: string, name: string) {
  try {
    await fn();
    assert(false, name, 'no error thrown');
  } catch (err) {
    const ok = err instanceof DesktopTrialError && err.code === code;
    assert(ok, name, err instanceof Error ? `${(err as DesktopTrialError).code || err.message}` : String(err));
  }
}

async function main() {
  console.log('\n=== Desktop trial unit tests (no DB) ===\n');

  assert(AUTO_TRIAL_APP_CODES.has(APP_CODE_KOOPPLUS_DESKTOP), 'allowlist includes KOOPPLUS_DESKTOP');
  assert(AUTO_TRIAL_APP_CODES.has(APP_CODE_MUVEKKIL_KASA_DESKTOP), 'allowlist includes MUVEKKIL_KASA_DESKTOP');
  assert(AUTO_TRIAL_APP_CODES.size === 2, 'allowlist has exactly two products');
  assert(
    !AUTO_TRIAL_APP_CODES.has('SIFRE_KASASI_DESKTOP'),
    'SIFRE_KASASI_DESKTOP is not in auto-trial allowlist'
  );
  const koopCfg = getDesktopTrialProgramConfig(APP_CODE_KOOPPLUS_DESKTOP);
  const mkCfg = getDesktopTrialProgramConfig(APP_CODE_MUVEKKIL_KASA_DESKTOP);
  assert(!!koopCfg && koopCfg.advisoryLockKey === 712409, 'KoopPlus advisory lock key unchanged');
  assert(koopCfg?.systemCustomerEmail === SYSTEM_TRIAL_CUSTOMER_EMAIL, 'KoopPlus system customer email unchanged');
  assert(koopCfg?.offlineGraceDays === 0, 'KoopPlus trial offline grace 0');
  assert(mkCfg?.offlineGraceDays === 0, 'MK trial offline grace 0');
  assert(mkCfg?.trialDays === 7, 'MK trial days 7');
  assert(mkCfg?.productName === MUVEKKIL_KASA_PROGRAM_DEFAULTS.name, 'MK trial product name');
  assert(mkCfg?.appCode === APP_CODE_MUVEKKIL_KASA_DESKTOP, 'MK trial appCode');
  assert(koopCfg?.alreadyUsedMessage.includes('KoopPlus') === true, 'KoopPlus already-used copy unchanged');

  assert(DESKTOP_TRIAL_DAYS === 7, 'trial length is 7 days');
  assert(DESKTOP_TRIAL_OFFLINE_GRACE_DAYS === 0, 'trial offline grace is 0');
  assert(config.offlineGraceDays === 7, 'paid offlineGraceDays remains 7');
  assert(KOOPPLUS_PROGRAM_DEFAULTS.appCode === 'KOOPPLUS_DESKTOP', 'program code KOOPPLUS_DESKTOP');
  assert(KOOPPLUS_PROGRAM_DEFAULTS.name === 'KoopPlus', 'program name KoopPlus');
  assert(KOOPPLUS_PROGRAM_DEFAULTS.defaultLicenseDays === 365, 'program duration 365 days');
  assert(KOOPPLUS_PROGRAM_DEFAULTS.defaultMaxDevices === 1, 'program maxDevices 1');
  assert(
    isSystemTrialLicenseNotes(`${SYSTEM_TRIAL_NOTES_PREFIX}KOOPPLUS_DESKTOP`),
    'SYSTEM_TRIAL notes prefix detected'
  );
  assert(!isSystemTrialLicenseNotes('Website sipariş no: X'), 'paid website notes are not trial');
  assert(
    DESKTOP_TRIAL_DAYS + DESKTOP_TRIAL_OFFLINE_GRACE_DAYS === 7,
    'trial does not become 14 days via grace'
  );

  const hex = 'a'.repeat(64);
  assert(DEVICE_HASH_SHA256_HEX.test(hex), '64-char lowercase hex accepted');
  assert(DEVICE_HASH_SHA256_HEX.test('A'.repeat(64)), '64-char uppercase hex accepted');
  assert(!DEVICE_HASH_SHA256_HEX.test('not-a-hash'), 'short hash rejected');
  assert(!DEVICE_HASH_SHA256_HEX.test('g'.repeat(64)), 'non-hex rejected');

  assert(TRIAL_ERROR_CODES.TRIAL_ALREADY_USED === 'TRIAL_ALREADY_USED', 'TRIAL_ALREADY_USED code');
  assert(TRIAL_ERROR_CODES.TRIAL_EXPIRED === 'TRIAL_EXPIRED', 'TRIAL_EXPIRED code');
  assert(
    TRIAL_ERROR_CODES.TRIAL_NOT_AVAILABLE_FOR_PRODUCT === 'TRIAL_NOT_AVAILABLE_FOR_PRODUCT',
    'TRIAL_NOT_AVAILABLE_FOR_PRODUCT code'
  );
  assert(
    TRIAL_ERROR_CODES.PROGRAM_NOT_FOUND_OR_INACTIVE === 'PROGRAM_NOT_FOUND_OR_INACTIVE',
    'PROGRAM_NOT_FOUND_OR_INACTIVE code'
  );
  assert(TRIAL_ERROR_CODES.INVALID_DEVICE_HASH === 'INVALID_DEVICE_HASH', 'INVALID_DEVICE_HASH code');

  await expectCode(
    () => startDesktopTrial({ appCode: APP_CODE_KOOPPLUS_DESKTOP, deviceHash: 'not-a-hash' }),
    TRIAL_ERROR_CODES.INVALID_DEVICE_HASH,
    'startDesktopTrial rejects invalid deviceHash before DB'
  );
  await expectCode(
    () => startDesktopTrial({ appCode: '', deviceHash: hex }),
    TRIAL_ERROR_CODES.INVALID_REQUEST,
    'startDesktopTrial rejects missing appCode before DB'
  );

  await expectCode(
    () =>
      startDesktopTrial({
        appCode: APP_CODE_KOOPPLUS_DESKTOP,
        deviceHash: hex,
        email: 'not-an-email',
        phone: '+905321234567',
      }),
    TRIAL_ERROR_CODES.INVALID_EMAIL,
    'startDesktopTrial rejects invalid email before DB'
  );
  await expectCode(
    () =>
      startDesktopTrial({
        appCode: APP_CODE_KOOPPLUS_DESKTOP,
        deviceHash: hex,
        email: 'ok@example.com',
        phone: '02121234567',
      }),
    TRIAL_ERROR_CODES.INVALID_PHONE,
    'startDesktopTrial rejects landline before DB'
  );

  assert(normalizeTrialEmail('  SERDAR@EXAMPLE.COM  ') === 'serdar@example.com', 'email trim+lowercase');
  assert(normalizeTurkishMobile('0532 123 45 67') === '+905321234567', 'TR mobile 0532…');
  assert(normalizeTurkishMobile('+90 532 123 45 67') === '+905321234567', 'TR mobile +90…');
  assert(normalizeTurkishMobile('0090 532 123 45 67') === '+905321234567', 'TR mobile 0090…');
  assert(normalizeTurkishMobile('(0532) 123-45-67') === '+905321234567', 'TR mobile punctuation');
  assert(TRIAL_ERROR_CODES.INVALID_EMAIL === 'INVALID_EMAIL', 'INVALID_EMAIL code');
  assert(TRIAL_ERROR_CODES.INVALID_PHONE === 'INVALID_PHONE', 'INVALID_PHONE code');

  console.log(`\n=== Unit results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
