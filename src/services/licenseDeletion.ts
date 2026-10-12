import { LicenseEventType, LicenseSource, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

export type LicenseDeletionBlocker =
  | 'ACTIVE_DEVICES'
  | 'ORDER_SOURCE'
  | 'WEBSITE_ORDER'
  | 'SAAS_DELIVERY'
  | 'WEBSITE_RENEWAL'
  | 'DESKTOP_PURCHASE'
  | 'TRIAL_GRANT'
  | 'DESKTOP_APP_USER';

export const LICENSE_DELETION_BLOCKER_MESSAGES: Record<LicenseDeletionBlocker, string> = {
  ACTIVE_DEVICES: 'Lisansta aktif cihaz var',
  ORDER_SOURCE: 'Lisans web sitesi siparişi veya API ile oluşturulmuş',
  WEBSITE_ORDER: 'Lisans bir web sitesi siparişine bağlı',
  SAAS_DELIVERY: 'Lisansa bağlı SaaS teslimatı var',
  WEBSITE_RENEWAL: 'Lisansın ödeme ile yenileme kaydı var',
  DESKTOP_PURCHASE: 'Lisans bir masaüstü satın alma oturumuna bağlı',
  TRIAL_GRANT: 'Lisansa bağlı demo kaydı var',
  DESKTOP_APP_USER: 'Lisansa bağlı masaüstü kullanıcı hesabı var',
};

export class LicenseDeletionError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'ALREADY_DELETED' | 'CONFIRMATION_MISMATCH' | 'BLOCKED',
    message: string,
    public readonly httpStatus: number,
    public readonly blockers: LicenseDeletionBlocker[] = []
  ) {
    super(message);
    this.name = 'LicenseDeletionError';
  }
}

type Db = Prisma.TransactionClient | typeof prisma;

export async function getLicenseDeletionBlockers(db: Db, licenseId: string): Promise<LicenseDeletionBlocker[]> {
  const license = await db.license.findUnique({
    where: { id: licenseId },
    select: {
      source: true,
      notes: true,
      desktopAppUser: { select: { id: true } },
      _count: {
        select: {
          devices: { where: { status: 'ACTIVE' } },
          saasDeliveries: true,
          websiteRenewals: true,
          desktopTrialGrants: true,
        },
      },
    },
  });
  if (!license) return [];
  const purchases = await db.desktopPurchaseSession.count({ where: { paidLicenseId: licenseId } });
  const blockers: LicenseDeletionBlocker[] = [];
  if (license._count.devices > 0) blockers.push('ACTIVE_DEVICES');
  if (license.source !== LicenseSource.MANUAL) blockers.push('ORDER_SOURCE');
  if (license.notes?.includes('Website sipariş no:')) blockers.push('WEBSITE_ORDER');
  if (license._count.saasDeliveries > 0) blockers.push('SAAS_DELIVERY');
  if (license._count.websiteRenewals > 0) blockers.push('WEBSITE_RENEWAL');
  if (purchases > 0) blockers.push('DESKTOP_PURCHASE');
  if (license._count.desktopTrialGrants > 0) blockers.push('TRIAL_GRANT');
  if (license.desktopAppUser) blockers.push('DESKTOP_APP_USER');
  return blockers;
}

/** Lisansı listelerden kaldırır ve erişimi kalıcı olarak iptal eder. Kayıt ve olay geçmişi silinmez. */
export async function softDeleteLicense(input: {
  licenseId: string;
  confirmLicenseKey: unknown;
  adminEmail: string;
  ipAddress?: string;
}) {
  return prisma.$transaction(
    async (tx) => {
      const license = await tx.license.findUnique({
        where: { id: input.licenseId },
        select: { id: true, licenseKey: true, deletedAt: true },
      });
      if (!license) throw new LicenseDeletionError('NOT_FOUND', 'Lisans bulunamadı', 404);
      if (license.deletedAt) throw new LicenseDeletionError('ALREADY_DELETED', 'Lisans zaten silinmiş', 409);
      if (typeof input.confirmLicenseKey !== 'string' || input.confirmLicenseKey.trim().toUpperCase() !== license.licenseKey) {
        throw new LicenseDeletionError('CONFIRMATION_MISMATCH', 'Onay için lisans anahtarı birebir yazılmalıdır', 400);
      }
      const blockers = await getLicenseDeletionBlockers(tx, license.id);
      if (blockers.length > 0) {
        throw new LicenseDeletionError(
          'BLOCKED',
          `Lisans silinemez: ${blockers.map((b) => LICENSE_DELETION_BLOCKER_MESSAGES[b]).join('; ')}`,
          409,
          blockers
        );
      }
      const deletedAt = new Date();
      const updated = await tx.license.updateMany({
        where: { id: license.id, deletedAt: null },
        data: { deletedAt, deletedByEmail: input.adminEmail },
      });
      if (updated.count !== 1) throw new LicenseDeletionError('ALREADY_DELETED', 'Lisans zaten silinmiş', 409);
      await tx.licenseEvent.create({
        data: {
          licenseId: license.id,
          eventType: LicenseEventType.LICENSE_DELETED,
          message: `Lisans silindi, erişim kalıcı olarak iptal edildi (${input.adminEmail})`,
          ipAddress: input.ipAddress,
        },
      });
      return { id: license.id, deletedAt };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}
