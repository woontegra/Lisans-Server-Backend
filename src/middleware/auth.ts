import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../lib/prisma';

export interface AuthPayload {
  adminId: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      admin?: AuthPayload;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Yetkilendirme gerekli' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, config.jwtSecret) as AuthPayload;
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token' });
  }
}

/** authMiddleware'den sonra kullanılır. Admin kaydı DB'den okunur; token içeriğine güvenilmez. */
export async function superAdminMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = req.admin
      ? await prisma.admin.findUnique({ where: { id: req.admin.adminId }, select: { email: true } })
      : null;
    if (!admin || !config.superAdminEmails.includes(admin.email.trim().toLowerCase())) {
      return res.status(403).json({ error: 'Bu işlem için SUPER_ADMIN yetkisi gerekli' });
    }
    req.admin = { ...req.admin!, email: admin.email };
    return next();
  } catch (err) {
    console.error('Super admin check error:', err);
    return res.status(500).json({ error: 'Sunucu hatası' });
  }
}

export function integrationAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const secret = req.headers['x-integration-secret'];
  if (!config.integrationSecret || secret !== config.integrationSecret) {
    return res.status(403).json({ error: 'Geçersiz entegrasyon anahtarı' });
  }
  next();
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}
