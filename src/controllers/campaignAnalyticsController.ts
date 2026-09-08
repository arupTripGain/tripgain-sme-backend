import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const getCampaignAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const campaignId = String(id);

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        enrollments: true,
        messages: true,
        events: true,
        conversions: true,
      }
    });

    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const totalEnrolled = campaign.enrollments.length;
    const sentMessages = campaign.messages.filter(m => m.status === 'sent' || m.status === 'delivered');
    const sentCount = sentMessages.length;
    
    // Sequence started = enrollments that have received at least one send or are active
    const sequenceStarted = campaign.enrollments.filter(e => e.lastSentAt || ['active', 'replied', 'completed', 'bounced'].includes(e.status)).length;

    // Events
    const openedEvents = campaign.events.filter(e => e.eventType === 'opened' || e.eventType === 'email.opened');
    const clickedEvents = campaign.events.filter(e => e.eventType === 'clicked' || e.eventType === 'email.clicked');
    const repliedEvents = campaign.events.filter(e => e.eventType === 'replied' || e.eventType === 'email.replied');

    // Check enrollment statuses
    const repliedEnrollments = campaign.enrollments.filter(e => e.status === 'replied').length;
    const repliesCount = Math.max(repliedEvents.length, repliedEnrollments);

    const registeredEnrollments = campaign.enrollments.filter(e => e.status === 'registered').length;
    const registrationsCount = Math.max(campaign.conversions.length, registeredEnrollments);

    const openRate = sentCount > 0 ? Math.round((openedEvents.length / sentCount) * 100) : 0;
    const clickRate = sentCount > 0 ? Math.round((clickedEvents.length / sentCount) * 100) : 0;
    const replyRate = sentCount > 0 ? Math.round((repliesCount / sentCount) * 100) : 0;

    // Generate 7-day Activity Timeline chart data
    const chartData = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
      const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

      const daySent = campaign.messages.filter(m => {
        const t = m.sentAt || m.createdAt;
        return t && t >= dayStart && t <= dayEnd && (m.status === 'sent' || m.status === 'delivered');
      }).length;

      const dayOpens = campaign.events.filter(e => {
        const t = e.eventAt || e.createdAt;
        return t && t >= dayStart && t <= dayEnd && (e.eventType === 'opened' || e.eventType === 'email.opened');
      }).length;

      const dayReplies = campaign.events.filter(e => {
        const t = e.eventAt || e.createdAt;
        return t && t >= dayStart && t <= dayEnd && (e.eventType === 'replied' || e.eventType === 'email.replied');
      }).length;

      chartData.push({
        date: dateStr,
        sent: daySent,
        opens: dayOpens,
        replies: dayReplies
      });
    }

    res.status(200).json({
      summary: {
        totalEnrolled,
        sequenceStarted: sequenceStarted > 0 ? sequenceStarted : (sentCount > 0 ? sentCount : 0),
        sent: sentCount,
        delivered: sentCount,
        opened: openedEvents.length,
        clicked: clickedEvents.length,
        replies: repliesCount,
        registrations: registrationsCount,
        openRate,
        clickRate,
        replyRate
      },
      chartData
    });
  } catch (error: any) {
    console.error('Error fetching campaign analytics:', error);
    res.status(500).json({ error: error?.message || 'Failed to fetch campaign analytics' });
  }
};
