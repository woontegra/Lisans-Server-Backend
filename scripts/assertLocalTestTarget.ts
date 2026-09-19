/**
 * Write testleri production Railway DB/API'ye asla gitmesin.
 */
const PRODUCTION_HINT = /railway|rlwy\.net|lisans-server-backend-production/i;
const LOCAL_HOST = /localhost|127\.0\.0\.1/i;

export function assertLocalDatabaseUrl(url = process.env.DATABASE_URL || ''): void {
  if (!url) {
    throw new Error('Tests require DATABASE_URL');
  }
  if (PRODUCTION_HINT.test(url)) {
    throw new Error('Refusing to run against production DATABASE_URL');
  }
  if (!LOCAL_HOST.test(url)) {
    throw new Error('Tests require local DATABASE_URL (localhost or 127.0.0.1)');
  }
}

export function assertLocalApiBase(base: string): void {
  if (PRODUCTION_HINT.test(base)) {
    throw new Error('Refusing to run against production API');
  }
  if (!LOCAL_HOST.test(base)) {
    throw new Error('Tests require local API_BASE (localhost or 127.0.0.1)');
  }
}
