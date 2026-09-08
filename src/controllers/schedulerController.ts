import { Request, Response } from 'express';
import { processEmailScheduler } from '../services/schedulerService';

export const runTick = async (req: Request, res: Response): Promise<void> => {
  try {
    const force = req.body?.force !== false;
    const bypassStepDelay = req.body?.bypassStepDelay !== false;
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
