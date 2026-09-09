import { Request, Response } from 'express';
import { AnalyticsService } from '../services/analyticsService';

export const getCampaignAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const campaignId = String(id);
    const { days, startDate, endDate } = req.query;

    const parsedDays = days ? parseInt(String(days), 10) : 7;
    const parsedStart = startDate ? new Date(String(startDate)) : undefined;
    const parsedEnd = endDate ? new Date(String(endDate)) : undefined;

    const overviewOptions: { startDate?: Date; endDate?: Date } = {};
    if (parsedStart && !isNaN(parsedStart.getTime())) overviewOptions.startDate = parsedStart;
    if (parsedEnd && !isNaN(parsedEnd.getTime())) overviewOptions.endDate = parsedEnd;

    const overview = await AnalyticsService.getCampaignOverview(campaignId, overviewOptions);

    const chartData = await AnalyticsService.getCampaignActivityTimeline(
      campaignId,
      parsedDays,
      overview.timezone
    );

    res.status(200).json({
      summary: overview.summary,
      funnel: overview.funnel,
      chartData,
      timezone: overview.timezone
    });
  } catch (error: any) {
    console.error('Error fetching campaign analytics:', error);
    res.status(500).json({ error: error?.message || 'Failed to fetch campaign analytics' });
  }
};

export const getCampaignStepAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const campaignId = String(id);

    const steps = await AnalyticsService.getCampaignStepPerformance(campaignId);
    res.status(200).json(steps);
  } catch (error: any) {
    console.error('Error fetching campaign step analytics:', error);
    res.status(500).json({ error: error?.message || 'Failed to fetch step analytics' });
  }
};

export const getCampaignLinkAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const campaignId = String(id);

    const links = await AnalyticsService.getCampaignLinkPerformance(campaignId);
    res.status(200).json(links);
  } catch (error: any) {
    console.error('Error fetching campaign link analytics:', error);
    res.status(500).json({ error: error?.message || 'Failed to fetch link analytics' });
  }
};

export const getCampaignContactAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const campaignId = String(id);
    const filter = String(req.query.filter || 'ALL');

    const contacts = await AnalyticsService.getCampaignContactEngagement(campaignId, filter);
    res.status(200).json(contacts);
  } catch (error: any) {
    console.error('Error fetching campaign contact analytics:', error);
    res.status(500).json({ error: error?.message || 'Failed to fetch contact analytics' });
  }
};

export const getContactTimeline = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id, enrollmentId } = req.params;
    const campaignId = String(id);

    const timeline = await AnalyticsService.getContactActivityTimeline(campaignId, String(enrollmentId));
    res.status(200).json(timeline);
  } catch (error: any) {
    console.error('Error fetching contact timeline:', error);
    res.status(500).json({ error: error?.message || 'Failed to fetch contact timeline' });
  }
};

export const exportCampaignAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const campaignId = String(id);

    const csvData = await AnalyticsService.exportCampaignAnalyticsCsv(campaignId);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="campaign-${campaignId}-analytics.csv"`);
    res.status(200).send(csvData);
  } catch (error: any) {
    console.error('Error exporting campaign analytics:', error);
    res.status(500).json({ error: error?.message || 'Failed to export campaign analytics' });
  }
};
