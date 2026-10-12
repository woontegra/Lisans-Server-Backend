import nodemailer from 'nodemailer';
import { config, isSmtpConfigured } from '../config';
import { normalizeDesktopEntitlementPlatform, type DesktopEntitlementPlatform } from '../lib/desktopPlatform';

export interface LicenseMailData {
  programName: string;
  customerEmail: string;
  customerName: string;
  licenseKey: string;
  activationPassword: string;
  downloadUrl?: string;
  expiresAt: Date;
  maxDevices?: number;
  /** License.platform. Doluysa yalnız bu platformun kurulum dosyası bağlantısı maile girer. */
  platform?: string | null;
  appCode?: string;
}

const PLATFORM_LABELS: Record<DesktopEntitlementPlatform, string> = { WINDOWS: 'Windows', MACOS: 'macOS' };
const INSTALLER_EXTENSIONS: Record<DesktopEntitlementPlatform, string[]> = {
  WINDOWS: ['.exe', '.msi'],
  MACOS: ['.dmg', '.pkg'],
};

/** Platformlu lisansta güncelleme beslemesi veya diğer platformun kurulum dosyası müşteriye gönderilmez. */
export function resolveMailDownloadUrl(downloadUrl: string | undefined, platform: string | null | undefined) {
  const raw = downloadUrl?.trim();
  if (!raw) return undefined;
  const required = normalizeDesktopEntitlementPlatform(platform);
  if (!required) return raw;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:') return undefined;
  const host = parsed.hostname.toLowerCase();
  const path = decodeURIComponent(parsed.pathname).toLowerCase();
  if (host === 'updates.woontegra.com' || host.endsWith('.updates.woontegra.com') || path.includes('/updates/')) {
    return undefined;
  }
  return INSTALLER_EXTENSIONS[required].some((ext) => path.endsWith(ext)) ? raw : undefined;
}

/** MK Desktop'ta platformlu lisansa ortam değişkenindeki kurulum adresi verilir; yoksa gelen bağlantı kullanılır. */
export function licenseMailDownloadUrl(input: {
  appCode?: string;
  platform?: string | null;
  downloadUrl?: string;
}): string | undefined {
  const platform = normalizeDesktopEntitlementPlatform(input.platform);
  const configured =
    input.appCode === 'MUVEKKIL_KASA_DESKTOP' && platform ? config.muvekkilKasaDownloadUrls[platform] : '';
  return resolveMailDownloadUrl(configured || input.downloadUrl, input.platform);
}

export async function sendDesktopAuthCode(input: {
  to: string;
  code: string;
  purpose: 'setup' | 'reset';
}): Promise<{ sent: boolean; error?: string }> {
  if (!isSmtpConfigured()) {
    return { sent: false, error: 'SMTP yapılandırılmamış. Doğrulama kodu gönderilemedi.' };
  }
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  const title = input.purpose === 'reset' ? 'Şifre sıfırlama kodu' : 'Hesap doğrulama kodu';
  const text = `${title}: ${input.code}\nKod 10 dakika geçerlidir ve bir kez kullanılabilir.\n\nWoontegra Yazılım`;
  try {
    await transporter.sendMail({
      from: config.smtp.from,
      to: input.to,
      subject: `${title} | Bilirkişi Hesap Desktop`,
      text,
      html: `<p>${title}</p><p style="font-size:24px;letter-spacing:4px;"><strong>${input.code}</strong></p><p>Kod 10 dakika geçerlidir ve bir kez kullanılabilir.</p>`,
    });
    return { sent: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Bilinmeyen mail hatası';
    return { sent: false, error: message };
  }
}

export async function sendLicenseMail(
  data: LicenseMailData
): Promise<{ sent: boolean; error?: string }> {
  if (!isSmtpConfigured()) {
    return { sent: false, error: 'SMTP yapılandırılmamış. Mail gönderilemedi.' };
  }

  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });

  const downloadUrl = licenseMailDownloadUrl(data);
  const downloadSection = downloadUrl ? `\nİndirme Bağlantısı: ${downloadUrl}\n` : '';
  const platform = normalizeDesktopEntitlementPlatform(data.platform);
  const platformLabel = platform ? PLATFORM_LABELS[platform] : undefined;
  const htmlRow = (label: string, value: string) => `
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">${label}</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${value}</td>
        </tr>`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a56db;">Woontegra Lisans ve Kurulum Bilgileri</h2>
      <p>Sayın ${data.customerName},</p>
      <p><strong>${data.programName}</strong> programınız için lisans bilgileriniz aşağıdadır:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Program</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${data.programName}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Lisans Anahtarı</td>
          <td style="padding: 8px; border: 1px solid #ddd; font-family: monospace;">${data.licenseKey}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Aktivasyon Şifresi</td>
          <td style="padding: 8px; border: 1px solid #ddd; font-family: monospace;">${data.activationPassword}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Bitiş Tarihi</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${data.expiresAt.toLocaleDateString('tr-TR')}</td>
        </tr>${data.maxDevices ? htmlRow('Cihaz Hakkı', String(data.maxDevices)) : ''}${platformLabel ? htmlRow('İşletim Sistemi', platformLabel) : ''}
      </table>
      ${downloadUrl ? `<p><strong>İndirme Bağlantısı:</strong> <a href="${downloadUrl}">${downloadUrl}</a></p>` : ''}
      <h3>Kurulum</h3>
      <ol>
        <li>Programı indirin ve kurun.</li>
        <li>Programı ilk açtığınızda lisans aktivasyon ekranı gelecektir.</li>
        <li>Lisans anahtarınızı ve aktivasyon şifrenizi girin.</li>
        <li>Aktivasyon tamamlandıktan sonra programı kullanmaya başlayabilirsiniz.</li>
      </ol>
      <p style="margin-top: 30px; color: #666;">
        <strong>Destek:</strong> Sorularınız için destek@woontegra.com adresine yazabilirsiniz.
      </p>
      <p style="color: #999; font-size: 12px;">Woontegra Yazılım</p>
    </div>
  `;

  const text = `
Woontegra Lisans ve Kurulum Bilgileri

Sayın ${data.customerName},

${data.programName} programınız için lisans bilgileriniz:

Program: ${data.programName}
Lisans Anahtarı: ${data.licenseKey}
Aktivasyon Şifresi: ${data.activationPassword}
Bitiş Tarihi: ${data.expiresAt.toLocaleDateString('tr-TR')}${data.maxDevices ? `\nCihaz Hakkı: ${data.maxDevices}` : ''}${platformLabel ? `\nİşletim Sistemi: ${platformLabel}` : ''}
${downloadSection}
Kurulum:
1. Programı indirin ve kurun.
2. Programı ilk açtığınızda lisans aktivasyon ekranı gelecektir.
3. Lisans anahtarınızı ve aktivasyon şifrenizi girin.
4. Aktivasyon tamamlandıktan sonra programı kullanmaya başlayabilirsiniz.

Destek: destek@woontegra.com

Woontegra Yazılım
  `.trim();

  try {
    await transporter.sendMail({
      from: config.smtp.from,
      to: data.customerEmail,
      subject: 'Woontegra Lisans ve Kurulum Bilgileri',
      text,
      html,
    });
    return { sent: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Bilinmeyen mail hatası';
    return { sent: false, error: `Mail gönderilemedi: ${message}` };
  }
}
