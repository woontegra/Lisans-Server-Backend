import type { Request, Response, NextFunction } from 'express';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 8;
const hits = new Map<string, number[]>();

function clientKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const ip =
    typeof forwarded === 'string' && forwarded.trim()
      ? forwarded.split(',')[0].trim()
      : req.socket.remoteAddress || 'unknown';
  return `${ip}:${req.path}`;
}

/** Yalnız desktop kullanıcı giriş ve kod denemeleri. Lisans activate/validate buna bağlı değildir. */
export function desktopAuthRateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const key = clientKey(req);
  const recent = (hits.get(key) || []).filter((t) => t > now - WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) {
    hits.set(key, recent);
    return res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      message: 'Çok fazla deneme. Lütfen bir süre sonra tekrar deneyin.',
    });
  }
  recent.push(now);
  hits.set(key, recent);
  return next();
}

export function resetDesktopAuthRateLimit(): void {
  hits.clear();
}
