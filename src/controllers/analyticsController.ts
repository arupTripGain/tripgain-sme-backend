import { Request, Response } from 'express';
import { PrismaClient, Campaign, ActivityLog } from '@prisma/client';

const prisma = new PrismaClient();

export const getGlobalAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    const totalContacts = await prisma.contact.count();
    const sent = await prisma.emailMessage.count({ where: { status: { in: ['sent', 'delivered'] } } });
    let delivered = await prisma.emailMessage.count({ where: { status: 'delivered' } });
    if (delivered === 0 && sent > 0) delivered = sent;
    const repliedEnrollments = await prisma.enrollment.count({ where: { status: 'replied' } });
    const repliedEvents = await prisma.emailEvent.count({ where: { eventType: 'replied' } });
    const replies = Math.max(repliedEnrollments, repliedEvents);
    const unsubscribed = await prisma.emailEvent.count({ where: { eventType: 'unsubscribed' } });
    
    // Fetch some real campaigns for performance metrics
    const campaigns = await prisma.campaign.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' }
    });

    const campaignPerformance = await Promise.all(campaigns.map(async (c: Campaign) => {
      const cSent = await prisma.emailMessage.count({ where: { campaignId: c.id, status: { in: ['sent', 'delivered'] } } });
      let cDelivered = await prisma.emailMessage.count({ where: { campaignId: c.id, status: 'delivered' } });
      if (cDelivered === 0 && cSent > 0) cDelivered = cSent;
      const cRepliedEnrollments = await prisma.enrollment.count({ where: { campaignId: c.id, status: 'replied' } });
      const cRepliedEvents = await prisma.emailEvent.count({ where: { campaignId: c.id, eventType: 'replied' } });
      const cReplies = Math.max(cRepliedEnrollments, cRepliedEvents);
      const cContacts = await prisma.enrollment.count({ where: { campaignId: c.id } });
      return {
        name: c.name,
        contacts: cContacts,
        sent: cSent,
        delivered: cDelivered,
        replies: cReplies
      };
    }));

    // Fetch actual recent activity
    const activityLogs = await prisma.activityLog.findMany({
      take: 6,
      orderBy: { createdAt: 'desc' }
    });

    const recentActivity = activityLogs.map((a: ActivityLog) => ({
      time: a.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      text: a.action + (a.description ? ` - ${a.description}` : '')
    }));
    
    const data = {
      overview: {
        contacts: { value: totalContacts.toLocaleString(), trend: '+0%' },
        sent: { value: sent.toLocaleString(), trend: '+0%' },
        delivered: { value: delivered.toLocaleString(), trend: '0%' },
        replies: { value: replies.toLocaleString(), trend: '0%' },
        positiveReplies: { value: '0', trend: '0%' }, 
        unsubscribed: { value: unsubscribed.toLocaleString(), trend: '0%' },
      },
      funnel: [
        { label: 'CONTACTS', value: totalContacts.toLocaleString() },
        { label: 'SENT', value: sent.toLocaleString() },
        { label: 'DELIVERED', value: delivered.toLocaleString() },
        { label: 'REPLIED', value: replies.toLocaleString() },
      ],
      campaignPerformance: campaignPerformance.length > 0 ? campaignPerformance : [],
      campaignComparison: {
        list: campaignPerformance.map((c: any) => ({
          name: c.name,
          replyRate: c.sent > 0 ? ((c.replies / c.sent) * 100).toFixed(1) + '%' : '0%',
          positiveReplyRate: '0%'
        })),
        best: campaignPerformance.length > 0 ? { 
          name: [...campaignPerformance].sort((a,b) => b.replies - a.replies)[0]?.name || 'None', 
          metric: 'Highest Replies' 
        } : { name: 'None', metric: '0%' },
        attention: { name: 'None', metric: 'Needs Data' }
      },
      sequencePerformance: [
        { step: 'Email 1', sent: sent.toString(), delivered: delivered.toString(), opens: '0', replies: replies.toString(), replyRate: '0%' }
      ],
      sequenceDropoff: {
        funnel: [
          { label: 'Enrolled', percentage: 100 },
        ],
        reasons: [
          { reason: 'Reply', count: replies },
          { reason: 'Unsubscribe', count: unsubscribed }
        ]
      },
      replyAnalytics: {
        total: replies,
        rate: sent > 0 ? ((replies / sent) * 100).toFixed(1) + '%' : '0%',
        positive: 0,
        positiveRate: '0%',
        types: [
          { type: 'Interested', count: 0 },
        ]
      },
      demographics: {
        industry: [],
        jobTitle: [],
        companySize: []
      },
      listPerformance: [],
      mailboxPerformance: [],
      emailEngagement: {
        sent: sent.toString(),
        delivered: delivered.toString(),
        opened: '0',
        clicked: '0',
        replied: replies.toString(),
        deliveryRate: sent > 0 ? ((delivered / sent) * 100).toFixed(1) + '%' : '0%',
        openRate: '0%',
        clickRate: '0%',
        replyRate: sent > 0 ? ((replies / sent) * 100).toFixed(1) + '%' : '0%'
      },
      deliverability: {
        sent: sent.toString(),
        delivered: delivered.toString(),
        bounced: '0',
        bounceRate: '0%',
        breakdown: {
          hardBounce: 0,
          softBounce: 0,
          spamComplaint: 0,
          unsubscribed: unsubscribed
        },
        health: {
          status: 'Healthy',
          bounceRate: '0%',
          complaintRate: '0%'
        },
        warning: 'System operating normally.'
      },
      unsubscribes: {
        total: unsubscribed,
        rate: sent > 0 ? ((unsubscribed / sent) * 100).toFixed(1) + '%' : '0%',
        topCampaigns: []
      },
      recentActivity: recentActivity.length > 0 ? recentActivity : [
        { time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), text: 'Analytics initialized' }
      ]
    };

    res.status(200).json(data);
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
};
