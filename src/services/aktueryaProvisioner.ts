import type { SaasProviderConfig } from '../config/saasProviders';
import { SAAS_PRODUCT_CODE_AKTUERYA } from '../constants/aktuerya';

export type AktueryaPlan = 'monthly' | 'yearly';
export type AktueryaProvisionResultCode = 'CREATED' | 'CONVERTED' | 'RENEWED';

export type AktueryaProvisionInput = {
  externalOrderId: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  plan: AktueryaPlan;
  paidAt: string;
  productCode?: string;
};

export type AktueryaProvisionPayload = {
  idempotentReplay: boolean;
  result: AktueryaProvisionResultCode;
  userId: string;
  subscriptionId: string;
  plan: AktueryaPlan;
  startsAt: string;
  expiresAt: string;
  mailSent: boolean;
};

export type AktueryaProvisionResult =
  | { ok: true; data: AktueryaProvisionPayload }
  | { ok: false; error: string; httpStatus?: number; raw?: Record<string, unknown> };

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SENSITIVE = /password|passwd|token|secret|api[-_]?key|authorization|bearer/i;

export function safeProvisionErrorCode(raw: unknown, httpStatus: number): string {
  if (typeof raw === 'string' && SAFE_ERROR_CODE.test(raw.trim())) return raw.trim();
  return `HTTP_${httpStatus}`;
}

export function sanitizeProvisionMessage(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 200) return undefined;
  if (SENSITIVE.test(trimmed)) return undefined;
  return trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readPlan(raw: unknown, fallback: AktueryaPlan): AktueryaPlan {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'monthly' || value === 'yearly') return value;
  return fallback;
}

function readResult(raw: unknown): AktueryaProvisionResultCode | null {
  if (raw === 'CREATED' || raw === 'CONVERTED' || raw === 'RENEWED') return raw;
  return null;
}

export function aktueryaProvisionBody(input: AktueryaProvisionInput) {
  return {
    externalOrderId: input.externalOrderId,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    customerPhone: input.customerPhone?.trim() || null,
    plan: input.plan,
    paidAt: input.paidAt,
    productCode: input.productCode?.trim() || SAAS_PRODUCT_CODE_AKTUERYA,
  };
}

/**
 * Aktüerya User/Subscription provision. Secret ve ham gövde loglanmaz.
 */
export async function provisionAktueryaSaas(
  provider: SaasProviderConfig,
  input: AktueryaProvisionInput,
  fetchImpl: typeof fetch = fetch
): Promise<AktueryaProvisionResult> {
  const url = `${provider.url}/internal/license/saas-provision`;
  const body = aktueryaProvisionBody(input);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-internal-api-key': provider.apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: 'SAAS_PROVISION_UNREACHABLE' };
  }

  const parsed = asRecord(await res.json().catch(() => null));

  if (res.status !== 200 || !parsed) {
    const code = safeProvisionErrorCode(parsed?.code, res.status);
    const message = sanitizeProvisionMessage(parsed?.message);
    return {
      ok: false,
      error: code,
      httpStatus: res.status,
      raw: {
        httpStatus: res.status,
        code,
        ...(message ? { message } : {}),
      },
    };
  }

  if (parsed.ok !== true || parsed.provisionStatus !== 'COMPLETED') {
    const code = safeProvisionErrorCode(parsed.code, res.status);
    const resolved = code === `HTTP_${res.status}` ? 'SAAS_PROVISION_NOT_COMPLETED' : code;
    return {
      ok: false,
      error: resolved,
      httpStatus: res.status,
      raw: { httpStatus: res.status, code: resolved },
    };
  }

  const userId = typeof parsed.userId === 'string' ? parsed.userId.trim() : '';
  const subscriptionId = typeof parsed.subscriptionId === 'string' ? parsed.subscriptionId.trim() : '';
  const startsAt = typeof parsed.startsAt === 'string' ? parsed.startsAt : '';
  const expiresAt = typeof parsed.expiresAt === 'string' ? parsed.expiresAt : '';
  const result = readResult(parsed.result);
  if (!userId || !subscriptionId || !startsAt || !expiresAt || !result) {
    return {
      ok: false,
      error: 'SAAS_PROVISION_INVALID_RESPONSE',
      httpStatus: res.status,
      raw: { httpStatus: res.status, code: 'SAAS_PROVISION_INVALID_RESPONSE' },
    };
  }

  return {
    ok: true,
    data: {
      idempotentReplay: parsed.idempotentReplay === true,
      result,
      userId,
      subscriptionId,
      plan: readPlan(parsed.plan, input.plan),
      startsAt,
      expiresAt,
      mailSent: parsed.mailSent === true,
    },
  };
}
