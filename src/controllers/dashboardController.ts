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

    // Recent Activity (Today) scoped to user
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const recentActivity = await prisma.activityLog.findMany({
      where: {
        userId: user.userId,
        createdAt: { gte: today }
      },
      orderBy: { createdAt: 'desc' },
      take: 5
    });

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
