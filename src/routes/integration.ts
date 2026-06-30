import { Router, Request, Response } from 'express';
import { LicenseSource, ProgramProductType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { integrationAuthMiddleware, getClientIp } from '../middleware/auth';
import { createLicense, regenerateActivationPassword } from '../services/licenseService';
import { handleSaasWebsiteOrder, isDesktopProgram } from '../services/saasOrderService';
import { parseProductType, toProgramDto, validateSaasProgramFields } from '../utils/programDto';

const router = Router();

const APP_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function normalizeAppCode(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase();
}

async function resolveOrCreateCustomer(
  customerName: string,
  customerEmail: string,
  customerPhone: string | null | undefined,
  orderNo: string
) {
  const normalizedEmail = String(customerEmail).trim().toLowerCase();
  const normalizedName = String(customerName).trim();
  const normalizedPhone = customerPhone?.trim() || null;

  let customer = await prisma.customer.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
  });

  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        name: normalizedName,
        email: normalizedEmail,
        phone: normalizedPhone,
        notes: `Website siparişi: ${orderNo}`,
      },
    });
  } else {
    const updates: { name?: string; phone?: string | null; email?: string } = {};
    if (normalizedName && customer.name !== normalizedName) {
      updates.name = normalizedName;
    }
    if (normalizedPhone && customer.phone !== normalizedPhone) {
      updates.phone = normalizedPhone;
    }
    if (customer.email !== normalizedEmail) {
      updates.email = normalizedEmail;
    }
    if (Object.keys(updates).length > 0) {
      customer = await prisma.customer.update({
        where: { id: customer.id },
        data: updates,
      });
    }
  }

  return customer;
}

router.get('/programs', integrationAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const activeOnly = req.query.activeOnly === 'true';
    const programs = await prisma.program.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      orderBy: { name: 'asc' },
    });
    return res.json(programs.map(toProgramDto));
  } catch (err) {
    console.error('List programs error:', err);
    return res.status(500).json({ error: 'Program listesi alınamadı' });
  }
});

router.get('/programs/:appCode', integrationAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const appCode = normalizeAppCode(req.params.appCode);
    if (!appCode) {
      return res.status(400).json({ error: 'appCode zorunludur' });
    }
    const program = await prisma.program.findUnique({ where: { appCode } });
    if (!program) {
      return res.status(404).json({ error: 'Program bulunamadı' });
    }
    return res.json(toProgramDto(program));
  } catch (err) {
    console.error('Get program error:', err);
    return res.status(500).json({ error: 'Program alınamadı' });
  }
});

router.post('/programs', integrationAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const appCode = normalizeAppCode(req.body?.appCode);
    const name = String(req.body?.name ?? '').trim();
    const description = req.body?.description ? String(req.body.description).trim() : null;
    const defaultLicenseDays =
      typeof req.body?.defaultLicenseDays === 'number' && req.body.defaultLicenseDays > 0
        ? Math.min(3650, Math.floor(req.body.defaultLicenseDays))
        : 365;
    const defaultMaxDevices =
      typeof req.body?.defaultMaxDevices === 'number' && req.body.defaultMaxDevices > 0
        ? Math.min(50, Math.floor(req.body.defaultMaxDevices))
        : 1;
    const isActive = req.body?.isActive !== false;
    const productType = parseProductType(req.body?.productType);
    const targetService = req.body?.targetService ? String(req.body.targetService).trim() : null;
    const saasProductCode = req.body?.saasProductCode ? String(req.body.saasProductCode).trim() : null;

    if (!appCode || !APP_CODE_PATTERN.test(appCode)) {
      return res.status(400).json({
        error: 'appCode büyük harf, rakam ve alt çizgi içermeli (ör. WOONTEGRA_ISLETME_KASASI)',
      });
    }
    if (!name) {
      return res.status(400).json({ error: 'Program adı zorunludur' });
    }

    const saasValidation = validateSaasProgramFields(productType, targetService, saasProductCode);
    if (saasValidation) {
      return res.status(400).json({ error: saasValidation });
    }

    const existing = await prisma.program.findUnique({ where: { appCode } });
    if (existing) {
      return res.status(409).json({ error: 'Bu appCode zaten kayıtlı', program: toProgramDto(existing) });
    }

    const program = await prisma.program.create({
      data: {
        appCode,
        name,
        description,
        productType,
        targetService: productType === ProgramProductType.SAAS ? targetService : null,
        saasProductCode: productType === ProgramProductType.SAAS ? saasProductCode : null,
        defaultLicenseDays,
        defaultMaxDevices,
        isActive,
      },
    });

    return res.status(201).json(toProgramDto(program));
  } catch (err) {
    console.error('Create program error:', err);
    return res.status(500).json({ error: 'Program oluşturulamadı' });
  }
});

router.get('/customer-licenses', integrationAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const email = String(req.query.email ?? '')
      .trim()
      .toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'email zorunludur' });
    }

    const customer = await prisma.customer.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!customer) {
      return res.json([]);
    }

    const licenses = await prisma.license.findMany({
      where: { customerId: customer.id },
      include: { program: { select: { appCode: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return res.json(
      licenses.map((lic) => {
        const notes = lic.notes ?? '';
        const marker = 'Website sipariş no:';
        const markerIdx = notes.indexOf(marker);
        const externalRef =
          markerIdx >= 0 ? notes.slice(markerIdx + marker.length).trim().split(/\s/)[0] ?? '' : '';
        const websiteOrderNo = externalRef ? externalRef.split(':')[0] || null : null;
        const normalized = lic.licenseKey.replace(/\s+/g, '').toUpperCase();
        const parts = normalized.split('-').filter(Boolean);
        const last = parts[parts.length - 1] ?? '';
        const tail = last.length >= 4 ? last.slice(-4) : '****';
        const licenseKeyMasked = `WNTG-****-****-****-${tail}`;

        return {
          id: lic.id,
          licenseKeyMasked,
          programName: lic.program.name,
          appCode: lic.program.appCode,
          productName: lic.program.name,
          websiteOrderNo,
          status: lic.status,
          expiresAt: lic.expiresAt.toISOString(),
          maxDevices: lic.maxDevices,
          createdAt: lic.createdAt.toISOString(),
        };
      }),
    );
  } catch (err) {
    console.error('Customer licenses error:', err);
    return res.status(500).json({ error: 'Müşteri lisansları alınamadı' });
  }
});

router.post(
  '/order-license',
  integrationAuthMiddleware,
  async (req: Request, res: Response) => {
    try {
      const {
        customerName,
        customerEmail,
        customerPhone,
        appCode,
        orderNo,
        downloadUrl,
        licenseDays,
        maxDevices,
        resendCredentials,
      } = req.body;

      if (!customerName || !customerEmail || !appCode || !orderNo) {
        return res.status(400).json({
          error: 'customerName, customerEmail, appCode ve orderNo zorunludur',
        });
      }

      const program = await prisma.program.findUnique({
        where: { appCode: normalizeAppCode(appCode) },
      });
      if (!program || !program.isActive) {
        return res.status(400).json({ error: 'Geçersiz veya pasif program kodu' });
      }

      const customer = await resolveOrCreateCustomer(
        customerName,
        customerEmail,
        customerPhone,
        orderNo
      );

      if (!isDesktopProgram(program)) {
        const saasResult = await handleSaasWebsiteOrder(program, customer, {
          customerId: customer.id,
          customerName: String(customerName).trim(),
          customerEmail: String(customerEmail).trim().toLowerCase(),
          customerPhone: customerPhone ? String(customerPhone).trim() : null,
          orderNo,
          licenseDays: licenseDays ?? program.defaultLicenseDays,
        });

        if (saasResult.ok) {
          return res.status(saasResult.alreadyExists ? 200 : 201).json({
            success: true,
            alreadyExists: saasResult.alreadyExists,
            deliveryType: 'SAAS',
            orderNo: saasResult.orderNo,
            programName: saasResult.programName,
            provisionStatus: saasResult.provisionStatus,
            externalTenantId: saasResult.externalTenantId ?? null,
            externalTenantSlug: saasResult.externalTenantSlug ?? null,
            loginUrl: saasResult.loginUrl ?? null,
            mailSent: saasResult.mailSent,
          });
        }

        return res.status(501).json({
          success: false,
          deliveryType: 'SAAS',
          orderNo: saasResult.orderNo,
          programName: saasResult.programName,
          error: saasResult.error,
          code: saasResult.error,
          provisionStatus: saasResult.provisionStatus,
        });
      }

      const noteMarker = `Website sipariş no: ${orderNo}`;
      const existing = await prisma.license.findFirst({
        where: { notes: noteMarker, source: LicenseSource.WEBSITE_ORDER },
        include: { program: true },
      });

      if (existing) {
        if (resendCredentials === true) {
          const activationPassword = await regenerateActivationPassword(existing.id, getClientIp(req));
          return res.status(200).json({
            success: true,
            alreadyExists: true,
            orderNo,
            licenseKey: existing.licenseKey,
            activationPassword,
            programName: existing.program.name,
            expiresAt: existing.expiresAt,
          });
        }
        return res.status(409).json({
          error: 'Bu sipariş için lisans zaten oluşturulmuş',
          alreadyExists: true,
          orderNo,
          licenseKey: existing.licenseKey,
        });
      }

      const result = await createLicense({
        customerId: customer.id,
        programId: program.id,
        source: LicenseSource.WEBSITE_ORDER,
        licenseDays: licenseDays ?? program.defaultLicenseDays,
        maxDevices: maxDevices ?? program.defaultMaxDevices,
        notes: `Website sipariş no: ${orderNo}`,
        sendMail: false,
        downloadUrl,
        ipAddress: getClientIp(req),
      });

      return res.status(201).json({
        success: true,
        orderNo,
        licenseKey: result.license.licenseKey,
        activationPassword: result.activationPassword,
        programName: program.name,
        expiresAt: result.license.expiresAt,
      });
    } catch (err) {
      console.error('Website order error:', err);
      const message = err instanceof Error ? err.message : 'Sipariş işlenemedi';
      return res.status(500).json({ error: message });
    }
  }
);

export default router;
