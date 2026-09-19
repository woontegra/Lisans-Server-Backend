import type { Request, Response, NextFunction } from 'express';
import { TRIAL_ERROR_CODES } from '../constants/desktopTrial';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 40;

const hits = new Map<string, number[]>();

function clientKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/** Yalnız trial public endpoint'leri. /activate ve /validate'e bağlanmaz. */
export function trialRateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const key = clientKey(req);
  const windowStart = now - WINDOW_MS;
  const recent = (hits.get(key) || []).filter((t) => t > windowStart);

  if (recent.length >= MAX_REQUESTS) {
    hits.set(key, recent);
    return res.status(429).json({
      success: false,
      code: TRIAL_ERROR_CODES.RATE_LIMITED,
      message: 'Çok fazla deneme. Lütfen bir süre sonra tekrar deneyin.',
    });
  }

  recent.push(now);
  hits.set(key, recent);
  return next();
}
