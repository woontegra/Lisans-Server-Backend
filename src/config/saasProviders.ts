export type SaasProviderConfig = {
  url: string;
  apiKey: string;
};

/**
 * targetService örn. MUVEKKIL_KASA → SAAS_PROVIDER_MUVEKKIL_KASA_URL / _API_KEY
 */
export function getSaasProviderConfig(targetService: string): SaasProviderConfig | null {
  const normalized = targetService
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) return null;

  const url = process.env[`SAAS_PROVIDER_${normalized}_URL`]?.trim();
  const apiKey = process.env[`SAAS_PROVIDER_${normalized}_API_KEY`]?.trim();
  if (!url || !apiKey) return null;

  return { url: url.replace(/\/$/, ''), apiKey };
}

export const SAAS_PROVISIONING_NOT_IMPLEMENTED = 'SAAS_PROVISIONING_NOT_IMPLEMENTED';
export const SAAS_PROVIDER_NOT_CONFIGURED = 'SAAS_PROVIDER_NOT_CONFIGURED';
export const SAAS_PRODUCT_CODE_MISSING = 'SAAS_PRODUCT_CODE_MISSING';
export const SAAS_TARGET_SERVICE_MISSING = 'SAAS_TARGET_SERVICE_MISSING';
