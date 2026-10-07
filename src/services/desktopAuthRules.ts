import crypto from 'crypto';

export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
export const AUTH_CODE_MAX_ATTEMPTS = 5;

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function assertUsername(raw: string): string {
  const username = normalizeUsername(raw);
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new Error('Kullanıcı adı 3-32 karakter olmalı ve yalnız harf, rakam, nokta, alt çizgi veya tire içermelidir.');
  }
  return username;
}

export function assertPassword(raw: string): string {
  const password = raw.trim();
  if (password.length < 8 || password.length > 72) {
    throw new Error('Parola 8-72 karakter olmalıdır.');
  }
  return password;
}

export function assertSecurity(questionRaw: string, answerRaw: string): { question: string; answer: string } {
  const question = questionRaw.trim();
  const answer = answerRaw.trim().toLowerCase();
  if (question.length < 4 || question.length > 160) {
    throw new Error('Güvenlik sorusu 4-160 karakter olmalıdır.');
  }
  if (answer.length < 2 || answer.length > 80) {
    throw new Error('Güvenlik cevabı 2-80 karakter olmalıdır.');
  }
  return { question, answer };
}

export function maskEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.indexOf('@');
  if (at <= 0) return '***';
  return `${normalized.slice(0, 1)}***@${normalized.slice(at + 1)}`;
}

export function generateAuthCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashAuthCode(secret: string, purpose: string, subjectId: string, code: string): string {
  return crypto.createHmac('sha256', secret).update(`${purpose}:${subjectId}:${code}`).digest('hex');
}

export function signDesktopSession(secret: string, userId: string, sessionVersion: number, now = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({ sub: userId, sv: sessionVersion, exp: now + 12 * 60 * 60 * 1000, aud: 'bilirkisi-desktop-user' }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', `${secret}:bilirkisi-desktop-user`).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function readDesktopSession(
  secret: string,
  token: string,
  now = Date.now(),
): { userId: string; sessionVersion: number } | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', `${secret}:bilirkisi-desktop-user`).update(body).digest('base64url');
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      sub?: string;
      sv?: number;
      exp?: number;
      aud?: string;
    };
    if (payload.aud !== 'bilirkisi-desktop-user' || !payload.sub || typeof payload.sv !== 'number') return null;
    if (!payload.exp || payload.exp <= now) return null;
    return { userId: payload.sub, sessionVersion: payload.sv };
  } catch {
    return null;
  }
}

export function paidSetupAllowed(input: {
  appCode: string;
  deviceActive: boolean;
  systemTrial: boolean;
  userExists: boolean;
}): { ok: true } | { ok: false; message: string } {
  if (input.appCode !== 'BILIRKISI_DESKTOP') return { ok: false, message: 'Program kodu eşleşmiyor' };
  if (!input.deviceActive) return { ok: false, message: 'Bu cihazda aktif lisans kaydı yok' };
  if (input.systemTrial) return { ok: false, message: 'Demo hakkı kullanıcı hesabına demo doğrulamasıyla bağlanır' };
  if (input.userExists) return { ok: false, message: 'Bu lisans için kullanıcı hesabı zaten var' };
  return { ok: true };
}

export function demoSetupAllowed(input: {
  grantActive: boolean;
  userExists: boolean;
}): { ok: true } | { ok: false; message: string } {
  if (!input.grantActive) return { ok: false, message: 'Aktif demo hakkı yok' };
  if (input.userExists) return { ok: false, message: 'Bu demo hakkı için kullanıcı hesabı zaten var' };
  return { ok: true };
}
