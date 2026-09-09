import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { processEmailScheduler } from '../services/schedulerService';
import { JWT_SECRET } from '../middleware/authMiddleware';

export function verifySchedulerAuth(
  authHeader: string | undefined,
  cronSecretHeader: string | undefined,
  user: any,
  expectedSecret: string,
  jwtSecret?: string
): { isAuthorized: boolean; status?: number; error?: string } {
  const secret = (expectedSecret || '').trim();

  if (!secret) {
    return { isAuthorized: false, status: 500, error: 'Server configuration error: CRON_SECRET not set' };
  }

  const rawAuth = (authHeader || '').trim();
  const rawCronSecret = (cronSecretHeader || '').trim();

  let bearerToken = '';
  if (rawAuth.toLowerCase().startsWith('bearer ')) {
    bearerToken = rawAuth.slice(7).trim();
  }

  const isCronAuthorized = secret.length > 0 && (
    bearerToken === secret || 
    rawCronSecret === secret
  );

  let isUserAuthorized = !!user;
  if (!isCronAuthorized && !isUserAuthorized && bearerToken && jwtSecret) {
    try {
      const decoded = jwt.verify(bearerToken, jwtSecret);
      if (decoded) isUserAuthorized = true;
    } catch (_) {}
  }

  if (!isCronAuthorized && !isUserAuthorized) {
    return { isAuthorized: false, status: 401, error: 'Unauthorized: missing or invalid cron secret' };
  }

  return { isAuthorized: true };
}

export const runTick = async (req: Request, res: Response): Promise<void> => {
  const expectedSecret = (process.env.CRON_SECRET || '').trim();

  // If in production and CRON_SECRET is missing, fail safely
  if (!expectedSecret && (process.env.NODE_ENV === 'production' || !!process.env.VERCEL)) {
    console.error('[Scheduler] CRON_SECRET is not configured in production environment variables.');
    res.status(500).json({ success: false, error: 'Server configuration error: CRON_SECRET not set' });
    return;
  }

  const authResult = verifySchedulerAuth(
    req.headers.authorization,
    req.headers['x-cron-secret'] as string | undefined,
    req.user,
    expectedSecret,
    JWT_SECRET
  );

  if (!authResult.isAuthorized) {
    res.status(authResult.status || 401).json({ success: false, error: authResult.error });
    return;
  }

  try {
    const isGet = req.method === 'GET';
    // Automated External Cron (GET) runs on standard cadence without bypass
    // Manual testing / admin actions (POST) can pass bypassStepDelay or force if explicitly provided
    const force = isGet ? false : Boolean(req.body?.force);
    const bypassStepDelay = isGet ? false : Boolean(req.body?.bypassStepDelay);
    const campaignId = req.body?.campaignId || req.query?.campaignId;

    const result = await processEmailScheduler({
      force,
      bypassStepDelay,
      campaignId: campaignId ? String(campaignId) : undefined
    });
    
    res.status(200).json({
      success: true,
      message: 'Scheduler tick complete',
      processed: result.emailsSent,
      sent: result.emailsSent,
      skipped: result.emailsSkipped,
      failed: result.emailsFailed
    });
  } catch (error: any) {
    console.error('[Scheduler] Error executing scheduler tick:', error);
    res.status(500).json({ success: false, error: error?.message || 'Failed to execute scheduler tick' });
  }
};
