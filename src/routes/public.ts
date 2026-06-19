import { Router, Request, Response } from 'express';
import {
  activateLicense,
  validateLicense,
} from '../services/licenseService';
import { getClientIp } from '../middleware/auth';

const router = Router();

router.post('/activate', async (req: Request, res: Response) => {
  try {
    const { licenseKey, activationPassword, appCode, deviceHash, deviceName, platform, appVersion } =
      req.body;

    if (!licenseKey || !activationPassword || !appCode || !deviceHash) {
      return res.status(400).json({
        success: false,
        message: 'licenseKey, activationPassword, appCode ve deviceHash zorunludur',
      });
    }

    const result = await activateLicense({
      licenseKey,
      activationPassword,
      appCode,
      deviceHash,
      deviceName,
      platform,
      appVersion,
      ipAddress: getClientIp(req),
    });

    const statusCode = result.success ? 200 : 400;
    return res.status(statusCode).json(result);
  } catch (err) {
    console.error('Activate error:', err);
    return res.status(500).json({ success: false, message: 'Sunucu hatası' });
  }
});

router.post('/validate', async (req: Request, res: Response) => {
  try {
    const { licenseKey, appCode, deviceHash } = req.body;

    if (!licenseKey || !appCode || !deviceHash) {
      return res.status(400).json({
        valid: false,
        message: 'licenseKey, appCode ve deviceHash zorunludur',
      });
    }

    const result = await validateLicense({
      licenseKey,
      appCode,
      deviceHash,
      ipAddress: getClientIp(req),
    });

    return res.json(result);
  } catch (err) {
    console.error('Validate error:', err);
    return res.status(500).json({ valid: false, message: 'Sunucu hatası' });
  }
});

export default router;
