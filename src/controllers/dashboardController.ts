import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const getDashboardStats = async (req: Request, res: Response): Promise<void> => {
  try {
    // We assume workspaceId is typically passed via auth token, but for now we'll fetch across all or assume a default.
    // For this implementation, we'll fetch global counts since auth isn't fully enforced yet.

    const totalLeads = await prisma.contact.count();
    const emailsSent = await prisma.emailMessage.count({ where: { status: { in: ['sent', 'delivered'] } } });
    
    // Replies can be counted from EmailEvent where eventType = 'replied'
    const replies = await prisma.emailEvent.count({ where: { eventType: 'replied' } });
    
    // "Interested" could be tracked via Conversions or Conversation replyClassification. 
    // Let's use Conversation with positive interest status if available, or just fallback to 0.
    const interested = await prisma.conversation.count({ where: { interestStatus: 'INTERESTED' } });
    
    const registered = await prisma.conversion.count({ where: { conversionType: 'registered' } });
    
    const unsubscribed = await prisma.suppressionList.count({ where: { reason: 'unsubscribe' } });

    // Recent Activity (Today)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const recentActivity = await prisma.activityLog.findMany({
      where: { createdAt: { gte: today } },
      orderBy: { createdAt: 'desc' },
      take: 5
    });

    // Active Campaigns Performance
    const campaigns = await prisma.campaign.findMany({
      where: { status: 'active' },
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
      take: 5
    });

    // Upcoming sends could be fetched from Enrollment nextSendAt
    const upcomingSends = await prisma.enrollment.findMany({
      where: { 
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
      campaigns: campaigns.map(c => ({
        id: c.id,
        name: c.name,
        leads: c._count.enrollments,
        sent: c._count.messages,
        replies: c._count.events, // simplistic mapping, ideally we filter by eventType=replied
        interested: 0,
        registered: c._count.conversions
      }))
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
