import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  databaseUrl: process.env.DATABASE_URL || '',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@woontegra.com',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  integrationSecret: process.env.INTEGRATION_SECRET || '',
  /** Virgülle ayrılmış SUPER_ADMIN e-postaları. Boşsa SUPER_ADMIN işlemleri kapalıdır. */
  superAdminEmails: (process.env.SUPER_ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'noreply@woontegra.com',
  },
  offlineGraceDays: 7,
  /** Müvekkil Kasa Desktop public kurulum dosyaları (updater ZIP / latest.yml değil). */
  muvekkilKasaDownloadUrls: {
    WINDOWS: process.env.MUVEKKIL_KASA_WINDOWS_DOWNLOAD_URL?.trim() || '',
    MACOS: process.env.MUVEKKIL_KASA_MACOS_DOWNLOAD_URL?.trim() || '',
  },
};

export {
  getSaasProviderConfig,
  SAAS_PROVISIONING_NOT_IMPLEMENTED,
  SAAS_PROVIDER_NOT_CONFIGURED,
  SAAS_PRODUCT_CODE_MISSING,
  SAAS_TARGET_SERVICE_MISSING,
} from './saasProviders';

export function isSmtpConfigured(): boolean {
  return !!(config.smtp.host && config.smtp.user && config.smtp.pass);
}
