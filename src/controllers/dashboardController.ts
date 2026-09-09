import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { OwnershipGuard } from '../utils/ownershipGuard';

const prisma = new PrismaClient();

export const getDashboardStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const totalLeads = await prisma.contact.count({
      where: { userId: user.userId }
    });

    const orConditions: Array<{ userId: string } | { owner: string }> = [{ userId: user.userId }];
    if (user.name) orConditions.push({ owner: user.name });
    if (user.email) orConditions.push({ owner: user.email });

    const userCampaigns = await prisma.campaign.findMany({
      where: { OR: orConditions },
      include: {
        _count: {
          select: {
            enrollments: true,
            messages: true,
            events: true,
            conversions: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    const userCampaignIds = userCampaigns.map(c => c.id);

    let emailsSent = 0;
    let replies = 0;
    let interested = 0;
    let registered = 0;

    if (userCampaignIds.length > 0) {
      emailsSent = await prisma.emailMessage.count({
        where: {
          campaignId: { in: userCampaignIds },
          status: { in: ['sent', 'delivered', 'opened', 'clicked', 'replied', 'bounced'] }
        }
      });
      replies = await prisma.emailEvent.count({
        where: {
          campaignId: { in: userCampaignIds },
          eventType: { in: ['replied', 'email.replied'] }
        }
      });
      interested = await prisma.conversation.count({
        where: {
          campaignId: { in: userCampaignIds },
          interestStatus: 'INTERESTED'
        }
      });
      registered = await prisma.conversion.count({
        where: {
          campaignId: { in: userCampaignIds },
          conversionType: 'registered'
        }
      });
    }

    const unsubscribed = await prisma.suppressionList.count({
      where: {
        userId: user.userId,
        reason: 'unsubscribe'
      }
    });

    // Fetch real outreach activity (Today's Activity with graceful recent fallback)
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const collectActivities = async (sinceDate?: Date) => {
      const rawItems: Array<{ action: string; description: string; createdAt: Date; key: string }> = [];

      if (userCampaignIds.length > 0) {
        // 1. Email Events (opens, clicks, replies, bounces)
        const eventWhere: any = { campaignId: { in: userCampaignIds } };
        if (sinceDate) eventWhere.createdAt = { gte: sinceDate };

        const events = await prisma.emailEvent.findMany({
          where: eventWhere,
          include: {
            campaign: { select: { name: true } },
            contact: { select: { fullName: true } }
          },
          orderBy: { createdAt: 'desc' },
          take: 25
        });

        for (const e of events) {
          const email = e.recipientEmail || e.contact?.fullName || 'Contact';
          const cName = e.campaign?.name ? `"${e.campaign.name}"` : 'campaign';
          let action = 'Email Event';
          let description = `${email} interacted with ${cName}`;

          if (e.eventType === 'opened' || e.eventType === 'email.opened') {
            action = 'Email Opened';
            description = `${email} opened email in ${cName}`;
          } else if (e.eventType === 'clicked' || e.eventType === 'email.clicked') {
            action = 'Link Clicked';
            description = `${email} clicked link in ${cName}`;
          } else if (e.eventType === 'replied' || e.eventType === 'email.replied') {
            action = 'Reply Received';
            description = `${email} replied to ${cName}`;
          } else if (e.eventType === 'bounced' || e.eventType === 'email.bounced') {
            action = 'Email Bounced';
            description = `Email to ${email} bounced in ${cName}`;
          }

          const timeBucket = Math.floor(new Date(e.createdAt).getTime() / (5 * 60 * 1000));
          rawItems.push({
            action,
            description,
            createdAt: e.createdAt,
            key: `${action}-${email}-${cName}-${timeBucket}`
          });
        }

        // 2. Email Messages (Sent / Delivered)
        const msgWhere: any = {
          campaignId: { in: userCampaignIds },
          status: { in: ['sent', 'delivered', 'opened', 'clicked', 'replied'] }
        };
        if (sinceDate) msgWhere.createdAt = { gte: sinceDate };

        const messages = await prisma.emailMessage.findMany({
          where: msgWhere,
          include: {
            campaign: { select: { name: true } }
          },
          orderBy: { createdAt: 'desc' },
          take: 20
        });

        for (const m of messages) {
          const email = m.toEmail || 'Contact';
          const subj = m.subject ? ` - "${m.subject}"` : '';
          rawItems.push({
            action: 'Email Sent',
            description: `Sent to ${email}${subj}`,
            createdAt: m.sentAt || m.createdAt,
            key: `sent-${m.id}`
          });
        }

        // 3. Enrollments (Lead Enrolled)
        const enrollWhere: any = { campaignId: { in: userCampaignIds } };
        if (sinceDate) enrollWhere.createdAt = { gte: sinceDate };

        const enrollments = await prisma.enrollment.findMany({
          where: enrollWhere,
          include: {
            campaign: { select: { name: true } },
            contact: {
              select: {
                fullName: true,
                emails: { select: { email: true }, take: 1 }
              }
            }
          },
          orderBy: { createdAt: 'desc' },
          take: 10
        });

        for (const en of enrollments) {
          const email = en.contact?.emails?.[0]?.email || en.contact?.fullName || 'Lead';
          const cName = en.campaign?.name ? `"${en.campaign.name}"` : 'campaign';
          rawItems.push({
            action: 'Lead Enrolled',
            description: `Enrolled ${email} into ${cName}`,
            createdAt: en.createdAt,
            key: `enrolled-${en.id}`
          });
        }
      }

      // 4. Activity Logs
      const logWhere: any = { userId: user.userId };
      if (sinceDate) logWhere.createdAt = { gte: sinceDate };

      const activityLogs = await prisma.activityLog.findMany({
        where: logWhere,
        orderBy: { createdAt: 'desc' },
        take: 10
      });

      for (const log of activityLogs) {
        rawItems.push({
          action: log.action || 'System Event',
          description: log.description || '',
          createdAt: log.createdAt,
          key: `log-${log.id}`
        });
      }

      const seen = new Set<string>();
      const deduped: Array<{ action: string; description: string; createdAt: Date }> = [];
      for (const item of rawItems) {
        if (!seen.has(item.key)) {
          seen.add(item.key);
          deduped.push({
            action: item.action,
            description: item.description,
            createdAt: item.createdAt
          });
        }
      }

      deduped.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return deduped;
    };

    let recentActivity = await collectActivities(today);
    if (recentActivity.length === 0) {
      recentActivity = await collectActivities();
    }
    recentActivity = recentActivity.slice(0, 8);

    // Upcoming sends scoped to user campaigns
    let upcomingSends: any[] = [];
    if (userCampaignIds.length > 0) {
      upcomingSends = await prisma.enrollment.findMany({
        where: { 
          campaignId: { in: userCampaignIds },
          status: 'active',
          nextSendAt: { not: null, gt: new Date() }
        },
        include: {
          contact: true,
          campaign: true
        },
        orderBy: { nextSendAt: 'asc' },
        take: 5
      });
    }

    const activeCampaigns = userCampaigns.filter(c => c.status === 'active').slice(0, 5);

    res.status(200).json({
      stats: {
        totalLeads,
        emailsSent,
        replies,
        interested,
        registered,
        unsubscribed
      },
      recentActivity,
      upcomingSends,
      campaigns: activeCampaigns.map(c => ({
        id: c.id,
        name: c.name,
        leads: c._count.enrollments,
        sent: c._count.messages,
        replies: c._count.events,
        interested: 0,
        registered: c._count.conversions
      }))
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
