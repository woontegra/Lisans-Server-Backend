import { Router, Request, Response } from 'express';
import { LicenseSource } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { integrationAuthMiddleware, getClientIp } from '../middleware/auth';
import { createLicense, regenerateActivationPassword } from '../services/licenseService';

const router = Router();

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

      const program = await prisma.program.findUnique({ where: { appCode } });
      if (!program || !program.isActive) {
        return res.status(400).json({ error: 'Geçersiz veya pasif program kodu' });
      }

      let customer = await prisma.customer.findFirst({
        where: { email: customerEmail },
      });

      if (!customer) {
        customer = await prisma.customer.create({
          data: {
            name: customerName,
            email: customerEmail,
            phone: customerPhone,
            notes: `Website siparişi: ${orderNo}`,
          },
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
