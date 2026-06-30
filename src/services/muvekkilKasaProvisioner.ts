import type { SaasProviderConfig } from '../config/saasProviders';

export type MuvekkilKasaProvisionInput = {
  externalOrderId: string;
  externalCustomerId: string;
  productCode: string;
  licenseDays: number;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
};

export type MuvekkilKasaProvisionSuccess = {
  idempotentReplay: boolean;
  tenantId: string;
  tenantSlug: string;
  loginUrl: string;
  mailSent: boolean;
  raw: Record<string, unknown>;
};

export type MuvekkilKasaProvisionResult =
  | { ok: true; data: MuvekkilKasaProvisionSuccess }
  | { ok: false; error: string; httpStatus?: number; raw?: unknown };

function addDays(date: Date, days: number): Date {
  const end = new Date(date);
  end.setDate(end.getDate() + Math.max(1, days));
  return end;
}

function buildProvisionBody(input: MuvekkilKasaProvisionInput) {
  const licenseStartDate = new Date();
  const licenseEndDate = addDays(licenseStartDate, input.licenseDays);

  return {
    externalOrderId: input.externalOrderId,
    externalCustomerId: input.externalCustomerId,
    productCode: input.productCode,
    licenseType: 'YEARLY' as const,
    licenseStatus: 'AKTIF' as const,
    licenseStartDate: licenseStartDate.toISOString(),
    licenseEndDate: licenseEndDate.toISOString(),
    tenant: {
      name: input.customerName,
      email: input.customerEmail,
      phone: input.customerPhone?.trim() || undefined,
    },
    owner: {
      fullName: input.customerName,
      email: input.customerEmail,
      phone: input.customerPhone?.trim() || undefined,
    },
    notes: `Website sipariş no: ${input.externalOrderId}`,
  };
}

export async function provisionMuvekkilKasaTenant(
  provider: SaasProviderConfig,
  input: MuvekkilKasaProvisionInput
): Promise<MuvekkilKasaProvisionResult> {
  const url = `${provider.url}/api/v1/internal/tenants/provision`;
  const body = buildProvisionBody(input);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-internal-api-key': provider.apiKey,
        'x-idempotency-key': input.externalOrderId,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Provision isteği başarısız';
    return { ok: false, error: `SAAS_PROVISION_REQUEST_FAILED: ${message}` };
  }

  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    const remoteError =
      (typeof raw.error === 'string' && raw.error) ||
      (typeof raw.message === 'string' && raw.message) ||
      `HTTP_${res.status}`;
    return {
      ok: false,
      error: String(remoteError),
      httpStatus: res.status,
      raw,
    };
  }

  if (raw.ok !== true) {
    return {
      ok: false,
      error: 'SAAS_PROVISION_INVALID_RESPONSE',
      httpStatus: res.status,
      raw,
    };
  }

  const tenant = raw.tenant as { id?: string; slug?: string } | undefined;
  const tenantId = tenant?.id?.trim();
  if (!tenantId) {
    return {
      ok: false,
      error: 'SAAS_PROVISION_MISSING_TENANT_ID',
      httpStatus: res.status,
      raw,
    };
  }

  return {
    ok: true,
    data: {
      idempotentReplay: raw.idempotentReplay === true,
      tenantId,
      tenantSlug: tenant?.slug?.trim() || tenantId,
      loginUrl: typeof raw.loginUrl === 'string' ? raw.loginUrl : '',
      mailSent: raw.mailSent === true,
      raw,
    },
  };
}
