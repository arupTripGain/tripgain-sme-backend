import { Request, Response } from 'express';
import { processEmailScheduler } from '../services/schedulerService';

export const runTick = async (req: Request, res: Response): Promise<void> => {
  // CRON_SECRET Authentication / Protection
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const authHeader = req.headers.authorization;
    const cronSecretHeader = req.headers['x-cron-secret'];
    const isCronAuthorized = (authHeader === `Bearer ${expectedSecret}`) || (cronSecretHeader === expectedSecret);
    const isUserAuthorized = !!req.user; // Authenticated admin/user via JWT/session

    if (!isCronAuthorized && !isUserAuthorized) {
      res.status(401).json({ error: 'Unauthorized: missing or invalid cron secret' });
      return;
    }
  }

  try {
    const isGet = req.method === 'GET';
    // Automated Vercel Cron (GET) runs on standard cadence without bypass
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
      message: 'Scheduler tick complete',
      processed: result.emailsSent,
      skipped: result.emailsSkipped,
      failed: result.emailsFailed
    });
  } catch (error: any) {
    console.error('Error executing scheduler tick:', error);
    res.status(500).json({ error: error?.message || 'Failed to execute scheduler tick' });
  }
};
