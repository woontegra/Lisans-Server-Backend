import { LicenseStatus } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { isSystemTrialLicenseNotes, APP_CODE_BILIRKISI_DESKTOP } from '../constants/desktopTrial';
import { hashPassword, verifyPassword } from '../utils/password';
import { sendDesktopAuthCode } from './mailService';
import {
  AUTH_CODE_MAX_ATTEMPTS,
  AUTH_CODE_TTL_MS,
  assertPassword,
  assertSecurity,
  assertUsername,
  demoSetupAllowed,
  generateAuthCode,
  hashAuthCode,
  maskEmail,
  paidSetupAllowed,
  readDesktopSession,
  signDesktopSession,
} from './desktopAuthRules';

export class DesktopAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DesktopAuthError';
  }
}

function secret(): string {
  return config.jwtSecret;
}

function assertApp(raw: unknown): string {
  const appCode = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (appCode !== APP_CODE_BILIRKISI_DESKTOP) {
    throw new DesktopAuthError(400, 'Program kodu eşleşmiyor', 'APP_CODE');
  }
  return appCode;
}

function assertHash(raw: unknown): string {
  const deviceHash = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(deviceHash)) {
    throw new DesktopAuthError(400, 'Cihaz doğrulanamadı', 'DEVICE');
  }
  return deviceHash;
}

async function paidLicense(licenseKeyRaw: unknown, deviceHashRaw: unknown, appCodeRaw: unknown) {
  const appCode = assertApp(appCodeRaw);
  const deviceHash = assertHash(deviceHashRaw);
  const licenseKey = typeof licenseKeyRaw === 'string' ? licenseKeyRaw.replace(/\s+/g, '').toUpperCase() : '';
  if (!licenseKey) throw new DesktopAuthError(400, 'Lisans anahtarı zorunludur', 'LICENSE_KEY');
  const license = await prisma.license.findUnique({
    where: { licenseKey },
    include: { customer: true, program: true },
  });
  if (!license || license.program.appCode !== appCode) {
    throw new DesktopAuthError(404, 'Lisans bulunamadı', 'LICENSE');
  }
  const device = await prisma.licenseDevice.findUnique({
    where: { licenseId_deviceHash: { licenseId: license.id, deviceHash } },
  });
  const active =
    !!device &&
    device.status === 'ACTIVE' &&
    license.status === LicenseStatus.ACTIVE &&
    license.expiresAt.getTime() > Date.now();
  return { license, deviceHash, active };
}

async function demoGrant(deviceHashRaw: unknown, appCodeRaw: unknown, platformRaw: unknown) {
  const appCode = assertApp(appCodeRaw);
  const deviceHash = assertHash(deviceHashRaw);
  const platform = typeof platformRaw === 'string' ? platformRaw.trim().toUpperCase() : '';
  if (platform !== 'WINDOWS' && platform !== 'MACOS') {
    throw new DesktopAuthError(400, 'Platform WINDOWS veya MACOS olmalıdır', 'PLATFORM');
  }
  const program = await prisma.program.findUnique({ where: { appCode } });
  if (!program) throw new DesktopAuthError(404, 'Ürün bulunamadı', 'PROGRAM');
  const grant = await prisma.desktopTrialGrant.findUnique({
    where: {
      programId_platformScope_deviceHash: {
        programId: program.id,
        platformScope: platform,
        deviceHash,
      },
    },
  });
  const active = !!grant && grant.status === 'ACTIVE' && grant.expiresAt.getTime() > Date.now();
  return { grant, active, platform };
}

async function issueCode(input: {
  purpose: 'ACCOUNT_SETUP' | 'PASSWORD_RESET';
  email: string;
  licenseId?: string | null;
  trialGrantId?: string | null;
  userId?: string | null;
}) {
  const code = generateAuthCode();
  const subjectId = input.licenseId || input.trialGrantId || input.userId || input.email;
  await prisma.desktopAuthCode.updateMany({
    where: {
      purpose: input.purpose,
      consumedAt: null,
      ...(input.licenseId ? { licenseId: input.licenseId } : {}),
      ...(input.trialGrantId ? { trialGrantId: input.trialGrantId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
    },
    data: { consumedAt: new Date() },
  });
  await prisma.desktopAuthCode.create({
    data: {
      purpose: input.purpose,
      codeHash: hashAuthCode(secret(), input.purpose, subjectId, code),
      emailNormalized: input.email,
      licenseId: input.licenseId ?? null,
      trialGrantId: input.trialGrantId ?? null,
      userId: input.userId ?? null,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
    },
  });
  const mailed = await sendDesktopAuthCode({
    to: input.email,
    code,
    purpose: input.purpose === 'PASSWORD_RESET' ? 'reset' : 'setup',
  });
  if (!mailed.sent) {
    throw new DesktopAuthError(503, mailed.error || 'Doğrulama kodu gönderilemedi', 'MAIL');
  }
  return subjectId;
}

async function takeCode(input: {
  purpose: 'ACCOUNT_SETUP' | 'PASSWORD_RESET';
  code: string;
  subjectId: string;
  licenseId?: string | null;
  trialGrantId?: string | null;
  userId?: string | null;
}) {
  const row = await prisma.desktopAuthCode.findFirst({
    where: {
      purpose: input.purpose,
      consumedAt: null,
      ...(input.licenseId ? { licenseId: input.licenseId } : {}),
      ...(input.trialGrantId ? { trialGrantId: input.trialGrantId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!row || row.expiresAt.getTime() <= Date.now()) {
    throw new DesktopAuthError(400, 'Doğrulama kodu geçersiz veya süresi dolmuş', 'CODE');
  }
  if (row.attemptCount >= AUTH_CODE_MAX_ATTEMPTS) {
    throw new DesktopAuthError(429, 'Doğrulama kodu deneme hakkı doldu', 'CODE_ATTEMPTS');
  }
  const expected = hashAuthCode(secret(), input.purpose, input.subjectId, input.code.trim());
  if (expected !== row.codeHash) {
    await prisma.desktopAuthCode.update({
      where: { id: row.id },
      data: { attemptCount: { increment: 1 } },
    });
    throw new DesktopAuthError(400, 'Doğrulama kodu hatalı', 'CODE');
  }
  await prisma.desktopAuthCode.update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  });
}

export async function paidAccountStatus(body: {
  licenseKey?: unknown;
  deviceHash?: unknown;
  appCode?: unknown;
}) {
  const { license, active } = await paidLicense(body.licenseKey, body.deviceHash, body.appCode);
  if (!active) throw new DesktopAuthError(403, 'Lisans bu cihazda aktif değil', 'LICENSE_INACTIVE');
  if (isSystemTrialLicenseNotes(license.notes)) {
    throw new DesktopAuthError(400, 'Demo hakkı kullanıcı hesabına demo doğrulamasıyla bağlanır', 'DEMO_PATH');
  }
  const user = await prisma.desktopAppUser.findUnique({ where: { licenseId: license.id } });
  return {
    success: true as const,
    account: user ? ('ready' as const) : ('missing' as const),
    maskedEmail: maskEmail(license.customer.email),
  };
}

export async function sendPaidSetupCode(body: {
  licenseKey?: unknown;
  deviceHash?: unknown;
  appCode?: unknown;
}) {
  const { license, active } = await paidLicense(body.licenseKey, body.deviceHash, body.appCode);
  const user = await prisma.desktopAppUser.findUnique({ where: { licenseId: license.id } });
  const gate = paidSetupAllowed({
    appCode: license.program.appCode,
    deviceActive: active,
    systemTrial: isSystemTrialLicenseNotes(license.notes),
    userExists: !!user,
  });
  if (!gate.ok) throw new DesktopAuthError(400, gate.message, 'SETUP');
  await issueCode({
    purpose: 'ACCOUNT_SETUP',
    email: license.customer.email.trim().toLowerCase(),
    licenseId: license.id,
  });
  return { success: true as const, maskedEmail: maskEmail(license.customer.email) };
}

export async function createPaidAccount(body: {
  licenseKey?: unknown;
  deviceHash?: unknown;
  appCode?: unknown;
  code?: unknown;
  username?: unknown;
  password?: unknown;
  securityQuestion?: unknown;
  securityAnswer?: unknown;
}) {
  const { license, active } = await paidLicense(body.licenseKey, body.deviceHash, body.appCode);
  const existing = await prisma.desktopAppUser.findUnique({ where: { licenseId: license.id } });
  const gate = paidSetupAllowed({
    appCode: license.program.appCode,
    deviceActive: active,
    systemTrial: isSystemTrialLicenseNotes(license.notes),
    userExists: !!existing,
  });
  if (!gate.ok) throw new DesktopAuthError(400, gate.message, 'SETUP');
  const username = assertUsername(String(body.username ?? ''));
  const password = assertPassword(String(body.password ?? ''));
  const security = assertSecurity(String(body.securityQuestion ?? ''), String(body.securityAnswer ?? ''));
  const email = license.customer.email.trim().toLowerCase();
  await takeCode({
    purpose: 'ACCOUNT_SETUP',
    code: String(body.code ?? ''),
    subjectId: license.id,
    licenseId: license.id,
  });
  try {
    const user = await prisma.desktopAppUser.create({
      data: {
        username,
        passwordHash: await hashPassword(password),
        securityQuestion: security.question,
        securityAnswerHash: await hashPassword(security.answer),
        emailNormalized: email,
        licenseId: license.id,
      },
    });
    return {
      success: true as const,
      token: signDesktopSession(secret(), user.id, user.sessionVersion),
      username: user.username,
    };
  } catch {
    throw new DesktopAuthError(409, 'Bu kullanıcı adı veya lisans hesabı kullanılamıyor', 'CONFLICT');
  }
}

export async function demoAccountStatus(body: {
  deviceHash?: unknown;
  appCode?: unknown;
  platform?: unknown;
}) {
  const { grant, active } = await demoGrant(body.deviceHash, body.appCode, body.platform);
  if (!grant || !active || !grant.emailNormalized) {
    throw new DesktopAuthError(404, 'Aktif demo hakkı yok', 'DEMO');
  }
  const user = await prisma.desktopAppUser.findUnique({ where: { trialGrantId: grant.id } });
  return {
    success: true as const,
    account: user ? ('ready' as const) : ('missing' as const),
    maskedEmail: maskEmail(grant.emailNormalized),
  };
}

export async function sendDemoSetupCode(body: {
  deviceHash?: unknown;
  appCode?: unknown;
  platform?: unknown;
}) {
  const { grant, active } = await demoGrant(body.deviceHash, body.appCode, body.platform);
  const user = grant ? await prisma.desktopAppUser.findUnique({ where: { trialGrantId: grant.id } }) : null;
  const gate = demoSetupAllowed({ grantActive: active && !!grant?.emailNormalized, userExists: !!user });
  if (!gate.ok || !grant?.emailNormalized) throw new DesktopAuthError(400, gate.ok ? 'Aktif demo hakkı yok' : gate.message, 'SETUP');
  await issueCode({
    purpose: 'ACCOUNT_SETUP',
    email: grant.emailNormalized,
    trialGrantId: grant.id,
  });
  return { success: true as const, maskedEmail: maskEmail(grant.emailNormalized) };
}

export async function createDemoAccount(body: {
  deviceHash?: unknown;
  appCode?: unknown;
  platform?: unknown;
  code?: unknown;
  username?: unknown;
  password?: unknown;
  securityQuestion?: unknown;
  securityAnswer?: unknown;
}) {
  const { grant, active } = await demoGrant(body.deviceHash, body.appCode, body.platform);
  const existing = grant ? await prisma.desktopAppUser.findUnique({ where: { trialGrantId: grant.id } }) : null;
  const gate = demoSetupAllowed({ grantActive: active && !!grant?.emailNormalized, userExists: !!existing });
  if (!gate.ok || !grant?.emailNormalized) throw new DesktopAuthError(400, gate.ok ? 'Aktif demo hakkı yok' : gate.message, 'SETUP');
  const username = assertUsername(String(body.username ?? ''));
  const password = assertPassword(String(body.password ?? ''));
  const security = assertSecurity(String(body.securityQuestion ?? ''), String(body.securityAnswer ?? ''));
  await takeCode({
    purpose: 'ACCOUNT_SETUP',
    code: String(body.code ?? ''),
    subjectId: grant.id,
    trialGrantId: grant.id,
  });
  try {
    const user = await prisma.desktopAppUser.create({
      data: {
        username,
        passwordHash: await hashPassword(password),
        securityQuestion: security.question,
        securityAnswerHash: await hashPassword(security.answer),
        emailNormalized: grant.emailNormalized,
        trialGrantId: grant.id,
      },
    });
    return {
      success: true as const,
      token: signDesktopSession(secret(), user.id, user.sessionVersion),
      username: user.username,
    };
  } catch {
    throw new DesktopAuthError(409, 'Bu kullanıcı adı veya demo hesabı kullanılamıyor', 'CONFLICT');
  }
}

export async function loginDesktopUser(body: { username?: unknown; password?: unknown }) {
  const username = assertUsername(String(body.username ?? ''));
  const password = String(body.password ?? '');
  const user = await prisma.desktopAppUser.findUnique({
    where: { username },
    include: { license: true, trialGrant: true },
  });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new DesktopAuthError(401, 'Kullanıcı adı veya parola hatalı', 'LOGIN');
  }
  if (user.license) {
    if (user.license.status !== LicenseStatus.ACTIVE || user.license.expiresAt.getTime() <= Date.now()) {
      throw new DesktopAuthError(403, 'Lisans süresi dolmuş veya pasif', 'LICENSE_EXPIRED');
    }
  } else if (user.trialGrant) {
    if (user.trialGrant.status !== 'ACTIVE' || user.trialGrant.expiresAt.getTime() <= Date.now()) {
      throw new DesktopAuthError(403, 'Demo süresi dolmuş', 'DEMO_EXPIRED');
    }
  } else {
    throw new DesktopAuthError(403, 'Hesaba bağlı lisans yok', 'LICENSE');
  }
  return {
    success: true as const,
    token: signDesktopSession(secret(), user.id, user.sessionVersion),
    username: user.username,
  };
}

export async function logoutDesktopUser(token: string) {
  const session = readDesktopSession(secret(), token);
  if (!session) throw new DesktopAuthError(401, 'Oturum geçersiz', 'SESSION');
  const user = await prisma.desktopAppUser.findUnique({ where: { id: session.userId } });
  if (!user || user.sessionVersion !== session.sessionVersion) {
    throw new DesktopAuthError(401, 'Oturum geçersiz', 'SESSION');
  }
  await prisma.desktopAppUser.update({
    where: { id: user.id },
    data: { sessionVersion: { increment: 1 } },
  });
  return { success: true as const };
}

export async function readSessionUser(token: string) {
  const session = readDesktopSession(secret(), token);
  if (!session) return null;
  const user = await prisma.desktopAppUser.findUnique({ where: { id: session.userId } });
  if (!user || user.sessionVersion !== session.sessionVersion) return null;
  return user;
}

export async function startPasswordReset(body: { username?: unknown }) {
  const username = assertUsername(String(body.username ?? ''));
  const user = await prisma.desktopAppUser.findUnique({ where: { username } });
  if (!user) throw new DesktopAuthError(404, 'Kullanıcı bulunamadı', 'USER');
  await issueCode({
    purpose: 'PASSWORD_RESET',
    email: user.emailNormalized,
    userId: user.id,
  });
  return { success: true as const, securityQuestion: user.securityQuestion, maskedEmail: maskEmail(user.emailNormalized) };
}

export async function completePasswordReset(body: {
  username?: unknown;
  code?: unknown;
  securityAnswer?: unknown;
  newPassword?: unknown;
}) {
  const username = assertUsername(String(body.username ?? ''));
  const user = await prisma.desktopAppUser.findUnique({ where: { username } });
  if (!user) throw new DesktopAuthError(404, 'Kullanıcı bulunamadı', 'USER');
  const answer = String(body.securityAnswer ?? '').trim().toLowerCase();
  if (!(await verifyPassword(answer, user.securityAnswerHash))) {
    throw new DesktopAuthError(400, 'Güvenlik cevabı hatalı', 'SECURITY');
  }
  const password = assertPassword(String(body.newPassword ?? ''));
  await takeCode({
    purpose: 'PASSWORD_RESET',
    code: String(body.code ?? ''),
    subjectId: user.id,
    userId: user.id,
  });
  await prisma.desktopAppUser.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(password),
      sessionVersion: { increment: 1 },
    },
  });
  return { success: true as const };
}
