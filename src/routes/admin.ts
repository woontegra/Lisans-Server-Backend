import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { LicenseSource, LicenseStatus, ProgramProductType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { authMiddleware, getClientIp } from '../middleware/auth';
import { verifyPassword } from '../utils/password';
import {
  createLicense,
  extendLicense,
  logLicenseEvent,
  regenerateActivationPassword,
  resetDevices,
} from '../services/licenseService';
import { sendLicenseMail } from '../services/mailService';
import { LicenseEventType } from '@prisma/client';
import { daysUntilExpiry, resolveLicenseStatus } from '../utils/license';
import { paramId } from '../utils/params';
import { parseProductType, validateSaasProgramFields } from '../utils/programDto';

const router = Router();

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'E-posta ve şifre zorunludur' });
    }

    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin) {
      return res.status(401).json({ error: 'Geçersiz kimlik bilgileri' });
    }

    const valid = await verifyPassword(password, admin.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Geçersiz kimlik bilgileri' });
    }

    const token = jwt.sign(
      { adminId: admin.id, email: admin.email },
      config.jwtSecret,
      { expiresIn: '24h' }
    );

    return res.json({
      token,
      admin: { id: admin.id, email: admin.email, name: admin.name },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
});

router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  const admin = await prisma.admin.findUnique({
    where: { id: req.admin!.adminId },
    select: { id: true, email: true, name: true },
  });
  if (!admin) return res.status(404).json({ error: 'Admin bulunamadı' });
  return res.json(admin);
});

router.get('/programs', authMiddleware, async (_req: Request, res: Response) => {
  const programs = await prisma.program.findMany({ orderBy: { name: 'asc' } });
  return res.json(programs);
});

router.post('/programs', authMiddleware, async (req: Request, res: Response) => {
  try {
    const {
      appCode,
      name,
      description,
      defaultLicenseDays,
      defaultMaxDevices,
      isActive,
      productType: rawProductType,
      targetService,
      saasProductCode,
    } = req.body;
    if (!appCode || !name) {
      return res.status(400).json({ error: 'appCode ve name zorunludur' });
    }

    const productType = parseProductType(rawProductType);
    const saasValidation = validateSaasProgramFields(
      productType,
      targetService,
      saasProductCode
    );
    if (saasValidation) {
      return res.status(400).json({ error: saasValidation });
    }

    const program = await prisma.program.create({
      data: {
        appCode: String(appCode).trim().toUpperCase(),
        name: String(name).trim(),
        description,
        productType,
        targetService:
          productType === ProgramProductType.SAAS ? String(targetService).trim() : null,
        saasProductCode:
          productType === ProgramProductType.SAAS ? String(saasProductCode).trim() : null,
        defaultLicenseDays: defaultLicenseDays ?? 365,
        defaultMaxDevices: defaultMaxDevices ?? 1,
        isActive: isActive ?? true,
      },
    });
    return res.status(201).json(program);
  } catch (err) {
    console.error('Create program error:', err);
    return res.status(500).json({ error: 'Program oluşturulamadı' });
  }
});

router.get('/customers', authMiddleware, async (req: Request, res: Response) => {
  const search = (req.query.search as string) || '';
  const customers = await prisma.customer.findMany({
    where: search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { companyName: { contains: search, mode: 'insensitive' } },
          ],
        }
      : undefined,
    orderBy: { name: 'asc' },
  });
  return res.json(customers);
});

router.post('/customers', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { name, email, phone, companyName, notes } = req.body;
    if (!name || !email) {
      return res.status(400).json({ error: 'name ve email zorunludur' });
    }
    const customer = await prisma.customer.create({
      data: { name, email, phone, companyName, notes },
    });
    return res.status(201).json(customer);
  } catch (err) {
    console.error('Create customer error:', err);
    return res.status(500).json({ error: 'Müşteri oluşturulamadı' });
  }
});

router.get('/dashboard', authMiddleware, async (_req: Request, res: Response) => {
  const now = new Date();
  const in30Days = new Date();
  in30Days.setDate(in30Days.getDate() + 30);

  const [total, active, expired, expiringSoon, byProgram] = await Promise.all([
    prisma.license.count(),
    prisma.license.count({
      where: { status: LicenseStatus.ACTIVE, expiresAt: { gt: now } },
    }),
    prisma.license.count({
      where: {
        OR: [
          { status: LicenseStatus.EXPIRED },
          { expiresAt: { lte: now }, status: { not: LicenseStatus.PASSIVE } },
        ],
      },
    }),
    prisma.license.count({
      where: {
        status: LicenseStatus.ACTIVE,
        expiresAt: { gt: now, lte: in30Days },
      },
    }),
    prisma.license.groupBy({
      by: ['programId'],
      _count: { id: true },
    }),
  ]);

  const programs = await prisma.program.findMany();
  const programMap = Object.fromEntries(programs.map((p) => [p.id, p]));

  return res.json({
    totalLicenses: total,
    activeLicenses: active,
    expiredLicenses: expired,
    expiringSoon,
    licensesByProgram: byProgram.map((g) => ({
      programId: g.programId,
      programName: programMap[g.programId]?.name || 'Bilinmeyen',
      appCode: programMap[g.programId]?.appCode || '',
      count: g._count.id,
    })),
  });
});

router.get('/licenses', authMiddleware, async (req: Request, res: Response) => {
  const search = (req.query.search as string) || '';
  const programId = req.query.programId as string | undefined;
  const status = req.query.status as LicenseStatus | undefined;

  const licenses = await prisma.license.findMany({
    where: {
      ...(programId ? { programId } : {}),
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { licenseKey: { contains: search, mode: 'insensitive' } },
              { customer: { name: { contains: search, mode: 'insensitive' } } },
              { customer: { email: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    include: {
      customer: true,
      program: true,
      devices: { where: { status: 'ACTIVE' } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const result = licenses.map((l) => ({
    ...l,
    activationPasswordHash: undefined,
    effectiveStatus: resolveLicenseStatus(l.status, l.expiresAt),
    activeDeviceCount: l.devices.length,
    daysUntilExpiry: daysUntilExpiry(l.expiresAt),
  }));

  return res.json(result);
});

router.get('/licenses/:id', authMiddleware, async (req: Request, res: Response) => {
  const license = await prisma.license.findUnique({
    where: { id: paramId(req) },
    include: {
      customer: true,
      program: true,
      devices: { orderBy: { firstActivatedAt: 'desc' } },
      events: { orderBy: { createdAt: 'desc' }, take: 100 },
    },
  });

  if (!license) return res.status(404).json({ error: 'Lisans bulunamadı' });

  return res.json({
    ...license,
    activationPasswordHash: undefined,
    effectiveStatus: resolveLicenseStatus(license.status, license.expiresAt),
    activeDeviceCount: license.devices.filter((d) => d.status === 'ACTIVE').length,
    daysUntilExpiry: daysUntilExpiry(license.expiresAt),
  });
});

router.post('/licenses', authMiddleware, async (req: Request, res: Response) => {
  try {
    const {
      customerId,
      newCustomer,
      programId,
      startsAt,
      expiresAt,
      licenseDays,
      maxDevices,
      notes,
      sendMail,
      downloadUrl,
    } = req.body;

    let resolvedCustomerId = customerId;

    if (!resolvedCustomerId && newCustomer) {
      const created = await prisma.customer.create({
        data: {
          name: newCustomer.name,
          email: newCustomer.email,
          phone: newCustomer.phone,
          companyName: newCustomer.companyName,
          notes: newCustomer.notes,
        },
      });
      resolvedCustomerId = created.id;
    }

    if (!resolvedCustomerId || !programId) {
      return res.status(400).json({ error: 'Müşteri ve program zorunludur' });
    }

    const result = await createLicense({
      customerId: resolvedCustomerId,
      programId,
      startsAt: startsAt ? new Date(startsAt) : undefined,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      licenseDays,
      maxDevices,
      notes,
      sendMail: !!sendMail,
      downloadUrl,
      ipAddress: getClientIp(req),
    });

    return res.status(201).json({
      license: {
        ...result.license,
        activationPasswordHash: undefined,
      },
      activationPassword: result.activationPassword,
      mailResult: result.mailResult,
      warning: 'Aktivasyon şifresi bir daha düz yazı gösterilmeyecektir. Lütfen kaydedin.',
    });
  } catch (err) {
    console.error('Create license error:', err);
    const message = err instanceof Error ? err.message : 'Lisans oluşturulamadı';
    return res.status(500).json({ error: message });
  }
});

router.patch('/licenses/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { maxDevices, notes, expiresAt, status } = req.body;
    const license = await prisma.license.update({
      where: { id: paramId(req) },
      data: {
        ...(maxDevices !== undefined ? { maxDevices } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
        ...(status ? { status } : {}),
      },
      include: { customer: true, program: true, devices: true },
    });
    return res.json({ ...license, activationPasswordHash: undefined });
  } catch (err) {
    console.error('Update license error:', err);
    return res.status(500).json({ error: 'Lisans güncellenemedi' });
  }
});

router.post('/licenses/:id/extend', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { days } = req.body;
    if (!days || days < 1) {
      return res.status(400).json({ error: 'Geçerli gün sayısı zorunludur' });
    }
    const license = await extendLicense(paramId(req), days, getClientIp(req));
    return res.json({ ...license, activationPasswordHash: undefined });
  } catch (err) {
    console.error('Extend license error:', err);
    return res.status(500).json({ error: 'Lisans uzatılamadı' });
  }
});

router.post('/licenses/:id/enable', authMiddleware, async (req: Request, res: Response) => {
  try {
    const license = await prisma.license.update({
      where: { id: paramId(req) },
      data: { status: LicenseStatus.ACTIVE },
      include: { customer: true, program: true, devices: true },
    });
    await logLicenseEvent(
      license.id,
      LicenseEventType.LICENSE_ENABLED,
      'Lisans aktif yapıldı',
      getClientIp(req)
    );
    return res.json({ ...license, activationPasswordHash: undefined });
  } catch (err) {
    return res.status(500).json({ error: 'İşlem başarısız' });
  }
});

router.post('/licenses/:id/disable', authMiddleware, async (req: Request, res: Response) => {
  try {
    const license = await prisma.license.update({
      where: { id: paramId(req) },
      data: { status: LicenseStatus.PASSIVE },
      include: { customer: true, program: true, devices: true },
    });
    await logLicenseEvent(
      license.id,
      LicenseEventType.LICENSE_DISABLED,
      'Lisans pasif yapıldı',
      getClientIp(req)
    );
    return res.json({ ...license, activationPasswordHash: undefined });
  } catch (err) {
    return res.status(500).json({ error: 'İşlem başarısız' });
  }
});

router.post('/licenses/:id/reset-devices', authMiddleware, async (req: Request, res: Response) => {
  try {
    await resetDevices(paramId(req), getClientIp(req));
    const license = await prisma.license.findUnique({
      where: { id: paramId(req) },
      include: { customer: true, program: true, devices: true },
    });
    return res.json({ ...license, activationPasswordHash: undefined });
  } catch (err) {
    return res.status(500).json({ error: 'Cihazlar sıfırlanamadı' });
  }
});

router.post(
  '/licenses/:id/regenerate-password',
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const activationPassword = await regenerateActivationPassword(
        paramId(req),
        getClientIp(req)
      );
      return res.json({
        activationPassword,
        warning: 'Aktivasyon şifresi bir daha düz yazı gösterilmeyecektir. Lütfen kaydedin.',
      });
    } catch (err) {
      return res.status(500).json({ error: 'Şifre yenilenemedi' });
    }
  }
);

router.post('/licenses/:id/send-mail', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { activationPassword, downloadUrl } = req.body;
    const license = await prisma.license.findUnique({
      where: { id: paramId(req) },
      include: { customer: true, program: true },
    });
    if (!license) return res.status(404).json({ error: 'Lisans bulunamadı' });

    if (!activationPassword) {
      return res.status(400).json({
        error:
          'Mail göndermek için aktivasyon şifresi gerekli. Yeni şifre üretin veya lisans oluşturma anındaki şifreyi kullanın.',
      });
    }

    const mailResult = await sendLicenseMail({
      programName: license.program.name,
      customerEmail: license.customer.email,
      customerName: license.customer.name,
      licenseKey: license.licenseKey,
      activationPassword,
      downloadUrl,
      expiresAt: license.expiresAt,
    });

    await logLicenseEvent(
      license.id,
      LicenseEventType.MAIL_SENT,
      mailResult.sent ? 'Lisans maili gönderildi' : mailResult.error,
      getClientIp(req)
    );

    return res.json(mailResult);
  } catch (err) {
    return res.status(500).json({ error: 'Mail gönderilemedi' });
  }
});

export default router;
