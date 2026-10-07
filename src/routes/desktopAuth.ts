import { Router, Request, Response } from 'express';
import { desktopAuthRateLimit } from '../middleware/desktopAuthRateLimit';
import { DesktopAuthError, completePasswordReset, createDemoAccount, createPaidAccount, demoAccountStatus, loginDesktopUser, logoutDesktopUser, paidAccountStatus, sendDemoSetupCode, sendPaidSetupCode, startPasswordReset } from '../services/desktopAuthService';

const router = Router();
router.use(desktopAuthRateLimit);

function fail(res: Response, err: unknown) {
  if (err instanceof DesktopAuthError) {
    return res.status(err.status).json({ success: false, code: err.code, message: err.message });
  }
  console.error('Desktop auth error:', err);
  return res.status(500).json({ success: false, message: 'İşlem tamamlanamadı' });
}

router.post('/paid/status', async (req: Request, res: Response) => {
  try {
    return res.json(await paidAccountStatus(req.body));
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/paid/send-code', async (req: Request, res: Response) => {
  try {
    return res.json(await sendPaidSetupCode(req.body));
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/paid/create-account', async (req: Request, res: Response) => {
  try {
    return res.status(201).json(await createPaidAccount(req.body));
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/demo/status', async (req: Request, res: Response) => {
  try {
    return res.json(await demoAccountStatus(req.body));
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/demo/send-code', async (req: Request, res: Response) => {
  try {
    return res.json(await sendDemoSetupCode(req.body));
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/demo/create-account', async (req: Request, res: Response) => {
  try {
    return res.status(201).json(await createDemoAccount(req.body));
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/login', async (req: Request, res: Response) => {
  try {
    return res.json(await loginDesktopUser(req.body));
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/logout', async (req: Request, res: Response) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    return res.json(await logoutDesktopUser(token));
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/forgot/start', async (req: Request, res: Response) => {
  try {
    return res.json(await startPasswordReset(req.body));
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/forgot/complete', async (req: Request, res: Response) => {
  try {
    return res.json(await completePasswordReset(req.body));
  } catch (err) {
    return fail(res, err);
  }
});

export default router;
