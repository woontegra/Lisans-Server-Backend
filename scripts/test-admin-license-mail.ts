/**
 * Admin manuel lisans maili testleri. SMTP taşıyıcısı mock'lanır; hiçbir mail dışarı gönderilmez.
 * Yalnız lokal DATABASE_URL. Production/Railway'e yazmaz.
 */
import nodemailer from 'nodemailer';
import { PrismaClient } from '@prisma/client';
import app from '../src/app';
import { config } from '../src/config';
import { resolveMailDownloadUrl } from '../src/services/mailService';
import { hashPassword } from '../src/utils/password';
import { assertLocalDatabaseUrl } from './assertLocalTestTarget';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@woontegra.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-strong-password';
const MK = 'MUVEKKIL_KASA_DESKTOP';
const OTHER = 'TEST_MAIL_OTHER_DESKTOP';
const NOTE_PREFIX = 'TEST-ADMINMAIL-';
const WIN_URL = 'https://download.example.test/muvekkil-kasa/windows/Woontegra-Muvekkil-Kasa-Defteri-Setup-1.0.0.exe';
const MAC_URL = 'https://download.example.test/muvekkil-kasa/macos/Woontegra-Muvekkil-Kasa-Defteri-1.0.0.dmg';

type SentMail = { to?: unknown; subject?: unknown; text?: string; html?: string };
const sent: SentMail[] = [];
let smtpMode: 'ok' | 'reject' | 'transport-throws' = 'ok';
const transportFactory = nodemailer as unknown as { createTransport: (...args: unknown[]) => unknown };
transportFactory.createTransport = () => {
  if (smtpMode === 'transport-throws') throw new Error('Mock transport init failure');
  return {
    sendMail: async (mail: SentMail) => {
      if (smtpMode === 'reject') throw new Error('Mock SMTP 550 recipient rejected');
      sent.push(mail);
      return { messageId: `mock-${sent.length}` };
    },
  };
};

const capturedLogs: string[] = [];
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    capturedLogs.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '));
    original(...args);
  };
}

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

function unitTests() {
  console.log('-- resolveMailDownloadUrl');
  assert(resolveMailDownloadUrl(WIN_URL, 'WINDOWS') === WIN_URL, 'Windows license keeps .exe link');
  assert(resolveMailDownloadUrl(MAC_URL, 'WINDOWS') === undefined, 'Windows license drops .dmg link');
  assert(resolveMailDownloadUrl(MAC_URL, 'MACOS') === MAC_URL, 'macOS license keeps .dmg link');
  assert(resolveMailDownloadUrl(WIN_URL, 'MACOS') === undefined, 'macOS license drops .exe link');
  assert(
    resolveMailDownloadUrl('https://updates.woontegra.com/updates/muvekkil-kasa-defteri/windows/Setup.exe', 'WINDOWS') === undefined,
    'updater feed host is never mailed'
  );
  assert(resolveMailDownloadUrl('https://download.example.test/windows/latest.yml', 'WINDOWS') === undefined, 'latest.yml dropped');
  assert(resolveMailDownloadUrl('http://download.example.test/Setup.exe', 'WINDOWS') === undefined, 'non-https link dropped');
  assert(resolveMailDownloadUrl('not a url', 'MACOS') === undefined, 'invalid URL dropped');
  assert(resolveMailDownloadUrl(undefined, 'WINDOWS') === undefined, 'missing link stays missing');
  assert(resolveMailDownloadUrl('https://example.test/any', null) === 'https://example.test/any', 'platformless license keeps link unchanged');
}

async function main() {
  console.log('\n=== Admin license mail tests (mock SMTP) ===\n');
  assertLocalDatabaseUrl();
  unitTests();

  const existingAdmin = await prisma.admin.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!existingAdmin) {
    await prisma.admin.create({
      data: { email: ADMIN_EMAIL, passwordHash: await hashPassword(ADMIN_PASSWORD), name: 'Test Admin' },
    });
  }

  config.muvekkilKasaDownloadUrls.WINDOWS = '';
  config.muvekkilKasaDownloadUrls.MACOS = '';
  config.smtp.host = 'smtp.mock.invalid';
  config.smtp.user = 'mock-user';
  config.smtp.pass = 'mock-pass';

  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await json('POST', '/api/admin/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  assert(login.status === 200 && !!login.data.token, 'Admin login');
  const auth = { Authorization: `Bearer ${login.data.token as string}` };

  const ensureProgram = async (appCode: string, name: string) => {
    const existing = await prisma.program.findUnique({ where: { appCode } });
    if (existing) return existing;
    return prisma.program.create({ data: { appCode, name, productType: 'DESKTOP', defaultLicenseDays: 365, defaultMaxDevices: 1 } });
  };
  const mkProgram = await ensureProgram(MK, 'Müvekkil Kasa Defteri Desktop');
  const otherProgram = await ensureProgram(OTHER, 'Test Diğer Desktop');

  const stamp = Date.now();
  let seq = 0;
  const create = (programId: string, extra: Record<string, unknown>) => {
    const n = seq++;
    const email = `admin-mail-${stamp}-${n}@example.invalid`;
    return json(
      'POST',
      '/api/admin/licenses',
      {
        newCustomer: { name: `Mail Test ${n}`, email },
        programId,
        licenseDays: 365,
        maxDevices: 2,
        notes: `${NOTE_PREFIX}${stamp}-${n}`,
        ...extra,
      },
      auth
    ).then((res) => ({ ...res, email }));
  };

  console.log('-- Manuel oluşturma her zaman mail gönderir');
  const before = sent.length;
  const legacyFlag = await create(mkProgram.id, { platform: 'WINDOWS', sendMail: false, downloadUrl: WIN_URL });
  assert(legacyFlag.status === 201, 'MK license created');
  assert(sent.length === before + 1 && sent[sent.length - 1].to === legacyFlag.email, 'mail sent even if client sends sendMail:false');
  assert(legacyFlag.data.mailResult?.sent === true, 'mailResult.sent true without any flag');
  const legacyEvents = await prisma.licenseEvent.findMany({
    where: { licenseId: legacyFlag.data.license.id, eventType: 'MAIL_SENT' },
  });
  assert(legacyEvents.length === 1 && legacyEvents[0].message === 'Lisans maili gönderildi', 'MAIL_SENT success event logged');
  assert(
    capturedLogs.some((l) => l.includes(`[license-mail] licenseId=${legacyFlag.data.license.id} sent=true`)),
    'mail result logged with license id'
  );

  console.log('-- MK Windows, mail açık');
  const win = await create(mkProgram.id, { platform: 'WINDOWS', sendMail: true, downloadUrl: WIN_URL });
  const winMail = sent[sent.length - 1];
  assert(win.status === 201 && win.data.mailResult?.sent === true, 'mailResult.sent true', JSON.stringify(win.data.mailResult));
  assert(winMail?.to === win.email, 'mail goes to the license customer only');
  for (const [label, body] of [['text', winMail?.text ?? ''], ['html', winMail?.html ?? '']] as const) {
    assert(body.includes(win.data.license.licenseKey), `${label}: license key present`);
    assert(body.includes(win.data.activationPassword), `${label}: activation password present`);
    assert(body.includes('Bitiş Tarihi'), `${label}: expiry present`);
    assert(body.includes('Cihaz Hakkı') && body.includes('2'), `${label}: device count present`);
    assert(body.includes('İşletim Sistemi') && body.includes('Windows'), `${label}: Windows OS present`);
    assert(body.includes(WIN_URL), `${label}: Windows installer link present`);
    assert(!body.includes('.dmg'), `${label}: no macOS link`);
  }

  console.log('-- MK Windows lisansına macOS bağlantısı verilirse');
  const winWrong = await create(mkProgram.id, { platform: 'WINDOWS', sendMail: true, downloadUrl: MAC_URL });
  const winWrongMail = sent[sent.length - 1];
  assert(winWrong.data.mailResult?.sent === true, 'mail still sent');
  assert(!winWrongMail.text?.includes(MAC_URL) && !winWrongMail.html?.includes(MAC_URL), 'macOS link not mailed to Windows license');
  assert(!winWrongMail.text?.includes('İndirme Bağlantısı'), 'no download section when no matching link');

  console.log('-- MK macOS');
  const mac = await create(mkProgram.id, { platform: 'MACOS', sendMail: true, downloadUrl: MAC_URL });
  const macMail = sent[sent.length - 1];
  assert(mac.data.mailResult?.sent === true, 'macOS mail sent');
  assert(macMail.text?.includes('macOS') === true && macMail.text?.includes(MAC_URL) === true, 'macOS OS and .dmg link present');
  const macWrong = await create(mkProgram.id, { platform: 'MACOS', sendMail: true, downloadUrl: WIN_URL });
  const macWrongMail = sent[sent.length - 1];
  assert(!macWrongMail.text?.includes(WIN_URL) && !macWrongMail.html?.includes(WIN_URL), 'Windows link not mailed to macOS license');

  console.log('-- MK, bağlantı verilmezse');
  const noLink = await create(mkProgram.id, { platform: 'WINDOWS', sendMail: true });
  const noLinkMail = sent[sent.length - 1];
  assert(noLink.data.mailResult?.sent === true, 'mail sent without link');
  assert(!noLinkMail.text?.includes('İndirme Bağlantısı'), 'no invented download link');

  console.log('-- Diğer program (platformsuz)');
  const otherUrl = 'https://download.example.test/other/Setup.zip';
  const other = await create(otherProgram.id, { sendMail: true, downloadUrl: otherUrl });
  const otherMail = sent[sent.length - 1];
  assert(other.status === 201 && other.data.license.platform === null, 'other program license has no platform');
  assert(otherMail.text?.includes(otherUrl) === true, 'other program link passes through unchanged');
  assert(!otherMail.text?.includes('İşletim Sistemi'), 'other program mail has no OS row');

  console.log('-- Detaydan tekrar gönderim');
  const beforeResend = sent.length;
  const wrongPw = await json(
    'POST',
    `/api/admin/licenses/${win.data.license.id}/send-mail`,
    { activationPassword: 'WRONG-PASSWORD' },
    auth
  );
  assert(wrongPw.status === 400 && sent.length === beforeResend, 'wrong activation password is rejected and nothing is mailed');
  const resend = await json(
    'POST',
    `/api/admin/licenses/${win.data.license.id}/send-mail`,
    { activationPassword: win.data.activationPassword, downloadUrl: MAC_URL },
    auth
  );
  const resendMail = sent[sent.length - 1];
  assert(resend.status === 200 && resend.data.sent === true, 'resend with correct password succeeds');
  assert(resendMail.text?.includes('Windows') === true && !resendMail.text?.includes(MAC_URL), 'resend keeps platform rules');

  console.log('-- MUVEKKIL_KASA_*_DOWNLOAD_URL yapılandırması');
  const CFG_WIN = 'https://download.example.test/downloads/muvekkil-kasa/windows/Woontegra-Muvekkil-Kasa-Defteri-Setup-9.9.9.exe';
  const CFG_MAC = 'https://download.example.test/downloads/muvekkil-kasa/macos/Woontegra-Muvekkil-Kasa-Defteri-9.9.9-mac-arm64.dmg';
  config.muvekkilKasaDownloadUrls.WINDOWS = CFG_WIN;
  config.muvekkilKasaDownloadUrls.MACOS = CFG_MAC;
  const lastMail = () => sent[sent.length - 1];
  const bodyOf = (m: SentMail) => `${m.text ?? ''}\n${m.html ?? ''}`;

  const cfgWin = await create(mkProgram.id, { platform: 'WINDOWS', sendMail: true });
  assert(cfgWin.data.mailResult?.sent === true, 'configured Windows mail sent');
  assert(bodyOf(lastMail()).includes(CFG_WIN) && !bodyOf(lastMail()).includes(CFG_MAC), 'Windows license gets only configured Windows installer');

  const cfgMac = await create(mkProgram.id, { platform: 'MACOS', sendMail: true });
  assert(cfgMac.data.mailResult?.sent === true, 'configured macOS mail sent');
  assert(bodyOf(lastMail()).includes(CFG_MAC) && !bodyOf(lastMail()).includes(CFG_WIN), 'macOS license gets only configured macOS installer');

  await create(mkProgram.id, { platform: 'WINDOWS', sendMail: true, downloadUrl: MAC_URL });
  assert(
    bodyOf(lastMail()).includes(CFG_WIN) && !bodyOf(lastMail()).includes(MAC_URL),
    'configured Windows installer wins over a supplied macOS link'
  );

  await create(mkProgram.id, { sendMail: true });
  assert(
    !bodyOf(lastMail()).includes(CFG_WIN) && !bodyOf(lastMail()).includes(CFG_MAC) && !lastMail().text?.includes('İndirme Bağlantısı'),
    'platformless legacy MK license gets no configured installer'
  );

  await create(otherProgram.id, { sendMail: true });
  assert(!bodyOf(lastMail()).includes(CFG_WIN) && !bodyOf(lastMail()).includes(CFG_MAC), 'other programs never get MK installers');

  const resendCfg = await json(
    'POST',
    `/api/admin/licenses/${cfgMac.data.license.id}/send-mail`,
    { activationPassword: cfgMac.data.activationPassword, downloadUrl: WIN_URL },
    auth
  );
  assert(
    resendCfg.data.sent === true && bodyOf(lastMail()).includes(CFG_MAC) && !bodyOf(lastMail()).includes(WIN_URL),
    'resend of macOS license uses configured macOS installer'
  );

  for (const [label, bad] of [
    ['updater ZIP', 'https://updates.woontegra.com/updates/muvekkil-kasa-defteri/windows/update-0.1.14.zip'],
    ['latest.yml', 'https://download.example.test/updates/muvekkil-kasa-defteri/windows/latest.yml'],
    ['plain ZIP', 'https://download.example.test/downloads/muvekkil-kasa/windows/Muvekkil-Kasa.zip'],
    ['Windows exe as macOS', CFG_WIN],
  ] as const) {
    const target = label === 'Windows exe as macOS' ? 'MACOS' : 'WINDOWS';
    config.muvekkilKasaDownloadUrls.WINDOWS = target === 'WINDOWS' ? bad : CFG_WIN;
    config.muvekkilKasaDownloadUrls.MACOS = target === 'MACOS' ? bad : CFG_MAC;
    await create(mkProgram.id, { platform: target, sendMail: true });
    assert(
      !bodyOf(lastMail()).includes(bad) && !lastMail().text?.includes('İndirme Bağlantısı'),
      `misconfigured ${label} is never mailed`
    );
  }
  config.muvekkilKasaDownloadUrls.WINDOWS = CFG_WIN;
  config.muvekkilKasaDownloadUrls.MACOS = '';
  await create(mkProgram.id, { platform: 'MACOS', sendMail: true });
  assert(!lastMail().text?.includes('İndirme Bağlantısı'), 'missing macOS config yields no link for macOS license');
  config.muvekkilKasaDownloadUrls.WINDOWS = '';

  console.log('-- SMTP gönderimi başarısız');
  const failedMailPasswords: string[] = [];
  for (const mode of ['reject', 'transport-throws'] as const) {
    smtpMode = mode;
    const beforeFail = sent.length;
    const licenseCountBefore = await prisma.license.count();
    const fail = await create(mkProgram.id, { platform: 'WINDOWS' });
    smtpMode = 'ok';
    failedMailPasswords.push(fail.data.activationPassword);
    assert(fail.status === 201 && !!fail.data.license?.id && !!fail.data.activationPassword, `${mode}: license still created (201)`);
    assert(fail.data.mailResult?.sent === false && !!fail.data.mailResult?.error, `${mode}: mailResult reports failure`, JSON.stringify(fail.data.mailResult));
    assert(sent.length === beforeFail, `${mode}: nothing delivered`);
    assert((await prisma.license.count()) === licenseCountBefore + 1, `${mode}: exactly one license row, no duplicate`);
    const failEvents = await prisma.licenseEvent.findMany({
      where: { licenseId: fail.data.license.id, eventType: 'MAIL_SENT' },
    });
    assert(
      failEvents.length === 1 && !!failEvents[0].message && failEvents[0].message.includes('Mock'),
      `${mode}: MAIL_SENT failure event logged`
    );
    assert(
      capturedLogs.some((l) => l.includes(`[license-mail] licenseId=${fail.data.license.id} sent=false`)),
      `${mode}: failure logged with license id`
    );
    const resendAfterFail = await json(
      'POST',
      `/api/admin/licenses/${fail.data.license.id}/send-mail`,
      { activationPassword: fail.data.activationPassword },
      auth
    );
    assert(resendAfterFail.status === 200 && resendAfterFail.data.sent === true, `${mode}: resend from detail works after failure`);
  }

  console.log('-- Otomatik akışlar değişmedi');
  const beforeOrder = sent.length;
  const order = await json(
    'POST',
    '/api/integrations/website/order-license',
    {
      customerName: 'Order Mail Test',
      customerEmail: `admin-mail-${stamp}-order@example.invalid`,
      appCode: MK,
      orderNo: `${NOTE_PREFIX}ORDER-${stamp}`,
      licenseDays: 365,
      platform: 'WINDOWS',
    },
    { 'x-integration-secret': process.env.INTEGRATION_SECRET || 'change-me-integration-secret' }
  );
  assert(order.status === 201, 'website order license created');
  assert(sent.length === beforeOrder, 'website order flow sends no license mail');
  const orderLicense = await prisma.license.findUnique({ where: { licenseKey: order.data.licenseKey } });
  assert(
    (await prisma.licenseEvent.count({ where: { licenseId: orderLicense!.id, eventType: 'MAIL_SENT' } })) === 0,
    'website order flow logs no MAIL_SENT'
  );

  console.log('-- SMTP yapılandırılmamış');
  config.smtp.host = '';
  const beforeNoSmtp = sent.length;
  const noSmtp = await create(mkProgram.id, { platform: 'MACOS', sendMail: true });
  assert(noSmtp.status === 201, 'license still created when SMTP missing');
  assert(noSmtp.data.mailResult?.sent === false && !!noSmtp.data.mailResult?.error, 'mailResult reports SMTP error');
  assert(sent.length === beforeNoSmtp, 'nothing mailed when SMTP missing');

  const created = await prisma.license.findMany({ where: { notes: { contains: NOTE_PREFIX } }, select: { id: true } });
  const issuedPasswords = [legacyFlag, win, mac, noLink, other, cfgWin, cfgMac, noSmtp]
    .map((r) => r.data.activationPassword as string)
    .concat(failedMailPasswords)
    .filter(Boolean);
  assert(
    issuedPasswords.length > 0 && !capturedLogs.some((l) => issuedPasswords.some((pw) => l.includes(pw))),
    'activation passwords never appear in logs'
  );
  const ids = created.map((row) => row.id);
  await prisma.licenseEvent.deleteMany({ where: { licenseId: { in: ids } } });
  await prisma.licenseDevice.deleteMany({ where: { licenseId: { in: ids } } });
  await prisma.license.deleteMany({ where: { id: { in: ids } } });
  await prisma.customer.deleteMany({ where: { email: { startsWith: `admin-mail-${stamp}-` } } });
  await prisma.program.deleteMany({ where: { appCode: OTHER } });

  await prisma.$disconnect();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
