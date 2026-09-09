import { Request, Response } from 'express';
import { processEmailScheduler } from '../services/schedulerService';

export const runTick = async (req: Request, res: Response): Promise<void> => {
  // CRON_SECRET Authentication / Protection
  const expectedSecret = (process.env.CRON_SECRET || '').trim();

  // If in production and CRON_SECRET is missing, fail safely
  if (!expectedSecret && (process.env.NODE_ENV === 'production' || !!process.env.VERCEL)) {
    console.error('[Scheduler] CRON_SECRET is not configured in production environment variables.');
    res.status(500).json({ success: false, error: 'Server configuration error: CRON_SECRET not set' });
    return;
  }

  const authHeader = (req.headers.authorization || '').trim();
  const cronSecretHeader = (req.headers['x-cron-secret'] as string || '').trim();

  // Extract Bearer token case-insensitively
  let bearerToken = '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    bearerToken = authHeader.slice(7).trim();
  }

  const isCronAuthorized = expectedSecret.length > 0 && (
    bearerToken === expectedSecret || 
    cronSecretHeader === expectedSecret
  );
  const isUserAuthorized = !!req.user; // Authenticated admin/user via JWT/session

  if (!isCronAuthorized && !isUserAuthorized) {
    res.status(401).json({ success: false, error: 'Unauthorized: missing or invalid cron secret' });
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
