import nodemailer from 'nodemailer';
import { config, isSmtpConfigured } from '../config';

export interface LicenseMailData {
  programName: string;
  customerEmail: string;
  customerName: string;
  licenseKey: string;
  activationPassword: string;
  downloadUrl?: string;
  expiresAt: Date;
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

  const downloadSection = data.downloadUrl
    ? `\nİndirme Bağlantısı: ${data.downloadUrl}\n`
    : '';

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
        </tr>
      </table>
      ${data.downloadUrl ? `<p><strong>İndirme Bağlantısı:</strong> <a href="${data.downloadUrl}">${data.downloadUrl}</a></p>` : ''}
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
Bitiş Tarihi: ${data.expiresAt.toLocaleDateString('tr-TR')}
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
