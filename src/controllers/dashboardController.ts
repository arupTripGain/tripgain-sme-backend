import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { OwnershipGuard } from '../utils/ownershipGuard';
import { getCalendarBucketBounds } from '../services/quotaService';
import { resolveEffectiveSendingDays, getZonedParts } from '../utils/businessDays';

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

/**
 * Calculates operationally truthful sending queue metrics matching
 * the scheduler's business-day, campaign, and mailbox eligibility rules.
 */
export async function calculateSendingQueueSummary(
  user: { userId: string; email?: string | null | undefined; name?: string | null | undefined },
  client: any = prisma,
  now: Date = new Date()
) {
  const tz = 'Asia/Kolkata';

  // 1. Resolve date buckets in Asia/Kolkata
  const todayBounds = getCalendarBucketBounds(now, tz);
  const tomorrowDate = new Date(todayBounds.endOfDay.getTime() + 1000);
  const tomorrowBounds = getCalendarBucketBounds(tomorrowDate, tz);
  const day2Date = new Date(tomorrowBounds.endOfDay.getTime() + 1000);
  const day2Bounds = getCalendarBucketBounds(day2Date, tz);
  const day3Date = new Date(day2Bounds.endOfDay.getTime() + 1000);
  const day3Bounds = getCalendarBucketBounds(day3Date, tz);

  const formatDateStr = (date: Date) => {
    const parts = getZonedParts(date, tz);
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  };

  const formatLabel = (date: Date) => {
    return date.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
  };

  const todayStr = formatDateStr(now);
  const tomorrowStr = formatDateStr(tomorrowDate);
  const day2Str = formatDateStr(day2Date);
  const day3Str = formatDateStr(day3Date);

  const emptyResponse = {
    timezone: tz,
    today: {
      date: todayStr,
      planned: 0,
      sent: 0,
      queued: 0,
      progressPercent: 0
    },
    tomorrow: {
      date: tomorrowStr,
      queued: 0
    },
    next3Days: {
      totalQueued: 0,
      days: [] as Array<{ date: string; label: string; queued: number }>
    }
  };

  // 2. Fetch user campaigns with minimal scalar fields
  const orConditions: Array<{ userId: string } | { owner: string }> = [{ userId: user.userId }];
  if (user.name) orConditions.push({ owner: user.name });
  if (user.email) orConditions.push({ owner: user.email });

  const campaigns = await client.campaign.findMany({
    where: { OR: orConditions },
    select: {
      id: true,
      name: true,
      status: true,
      approvalStatus: true,
      sendingDays: true,
      senderMailboxes: true,
      timezone: true
    }
  });

  if (!campaigns || campaigns.length === 0) {
    return emptyResponse;
  }

  const allCampaignIds = campaigns.map((c: any) => c.id);

  // 3. SENT Today: ground truth dispatched email messages for user's campaigns today (Asia/Kolkata)
  let sentToday = 0;
  if (allCampaignIds.length > 0) {
    sentToday = await client.emailMessage.count({
      where: {
        campaignId: { in: allCampaignIds },
        status: { in: ['sent', 'delivered', 'opened', 'clicked', 'replied', 'bounced'] },
        sentAt: { gte: todayBounds.startOfDay, lt: todayBounds.endOfDay }
      }
    });
  }

  // 4. Eligible active campaigns (approved & active)
  const activeCampaigns = campaigns.filter((c: any) =>
    c.status === 'active' && (!c.approvalStatus || c.approvalStatus === 'APPROVED')
  );

  if (activeCampaigns.length === 0) {
    const planned = sentToday;
    const progressPercent = planned > 0 ? 100 : 0;
    return {
      timezone: tz,
      today: {
        date: todayStr,
        planned,
        sent: sentToday,
        queued: 0,
        progressPercent
      },
      tomorrow: {
        date: tomorrowStr,
        queued: 0
      },
      next3Days: {
        totalQueued: 0,
        days: []
      }
    };
  }

  // 5. Active, connected mailboxes
  const configuredMailboxRefs = Array.from(
    new Set(activeCampaigns.flatMap((c: any) => c.senderMailboxes || []))
  );

  const activeMailboxes = await client.mailbox.findMany({
    where: {
      OR: [
        ...(configuredMailboxRefs.length > 0 ? [
          { id: { in: configuredMailboxRefs } },
          { email: { in: configuredMailboxRefs } }
        ] : []),
        { status: 'CONNECTED', isActive: true }
      ],
      status: 'CONNECTED',
      isActive: true
    },
    select: {
      id: true,
      email: true,
      sendingDays: true,
      sendingTimezone: true,
      status: true,
      isActive: true
    }
  });

  const activeMailboxIds = activeMailboxes.map((m: any) => m.id);

  // 6. Campaign-level allowed days evaluation
  // Maps campaignId -> Set of canonical allowed weekdays (e.g. Set('MON', 'TUE', ...))
  const campaignAllowedDaysMap = new Map<string, Set<string>>();

  for (const camp of activeCampaigns) {
    const configured = camp.senderMailboxes || [];
    let matchedMbs = activeMailboxes.filter((m: any) =>
      configured.includes(m.id) || configured.includes(m.email)
    );
    if (matchedMbs.length === 0 && activeMailboxes.length > 0) {
      matchedMbs = [activeMailboxes[0]!];
    }

    if (matchedMbs.length === 0) {
      // Campaign has no active connected mailbox -> cannot dispatch
      continue;
    }

    const allowedDays = new Set<string>();
    for (const mb of matchedMbs) {
      const days = resolveEffectiveSendingDays({
        campaignDays: camp.sendingDays,
        mailboxDays: mb.sendingDays
      });
      for (const d of days) allowedDays.add(d);
    }

    if (allowedDays.size > 0) {
      campaignAllowedDaysMap.set(camp.id, allowedDays);
    }
  }

  const canSendOnDay = (campaignId: string, dayOfWeek: string): boolean => {
    const days = campaignAllowedDaysMap.get(campaignId);
    return !!days && days.has(dayOfWeek);
  };

  const eligibleCampIdsToday = activeCampaigns
    .filter((c: any) => canSendOnDay(c.id, todayBounds.currentDayOfWeek))
    .map((c: any) => c.id);

  const eligibleCampIdsTomorrow = activeCampaigns
    .filter((c: any) => canSendOnDay(c.id, tomorrowBounds.currentDayOfWeek))
    .map((c: any) => c.id);

  const eligibleCampIdsDay2 = activeCampaigns
    .filter((c: any) => canSendOnDay(c.id, day2Bounds.currentDayOfWeek))
    .map((c: any) => c.id);

  const eligibleCampIdsDay3 = activeCampaigns
    .filter((c: any) => canSendOnDay(c.id, day3Bounds.currentDayOfWeek))
    .map((c: any) => c.id);

  // 7. Check suppression list for user
  let suppressedNormalizedEmails: string[] = [];
  if (client.suppressionList) {
    const suppressedCount = await client.suppressionList.count({
      where: { userId: user.userId }
    });
    if (suppressedCount > 0) {
      const suppressedList = await client.suppressionList.findMany({
        where: { userId: user.userId },
        select: { normalizedEmail: true },
        take: 10000
      });
      suppressedNormalizedEmails = suppressedList.map((s: any) => s.normalizedEmail);
    }
  }

  // Base filter for eligible queued enrollments:
  // - status in ['pending', 'active']
  // - stoppedAt is null
  // - contact not marked doNotContact, not unsubscribed, not on suppression list
  // - mailbox eligibility: unassigned new leads (mailboxId null & lastSentAt null) OR assigned to active connected mailbox
  const baseEnrollmentWhere: any = {
    status: { in: ['pending', 'active'] },
    stoppedAt: null,
    contact: {
      doNotContact: false,
      unsubscribeAt: null,
      ...(suppressedNormalizedEmails.length > 0 ? {
        emails: {
          none: {
            normalizedEmail: { in: suppressedNormalizedEmails }
          }
        }
      } : {})
    },
    OR: [
      { mailboxId: null, lastSentAt: null },
      ...(activeMailboxIds.length > 0 ? [{ mailboxId: { in: activeMailboxIds } }] : [])
    ]
  };

  // 8. Execute targeted count queries in parallel (indexed, COUNT only, no full object hydration)
  const [queuedToday, queuedTomorrow, queuedDay2, queuedDay3] = await Promise.all([
    // Today
    eligibleCampIdsToday.length > 0
      ? client.enrollment.count({
          where: {
            campaignId: { in: eligibleCampIdsToday },
            ...baseEnrollmentWhere,
            OR: [
              { nextSendAt: { lte: todayBounds.endOfDay } },
              { nextSendAt: null }
            ]
          }
        })
      : Promise.resolve(0),

    // Tomorrow
    eligibleCampIdsTomorrow.length > 0
      ? client.enrollment.count({
          where: {
            campaignId: { in: eligibleCampIdsTomorrow },
            ...baseEnrollmentWhere,
            nextSendAt: {
              gte: tomorrowBounds.startOfDay,
              lt: tomorrowBounds.endOfDay
            }
          }
        })
      : Promise.resolve(0),

    // Day 2
    eligibleCampIdsDay2.length > 0
      ? client.enrollment.count({
          where: {
            campaignId: { in: eligibleCampIdsDay2 },
            ...baseEnrollmentWhere,
            nextSendAt: {
              gte: day2Bounds.startOfDay,
              lt: day2Bounds.endOfDay
            }
          }
        })
      : Promise.resolve(0),

    // Day 3
    eligibleCampIdsDay3.length > 0
      ? client.enrollment.count({
          where: {
            campaignId: { in: eligibleCampIdsDay3 },
            ...baseEnrollmentWhere,
            nextSendAt: {
              gte: day3Bounds.startOfDay,
              lt: day3Bounds.endOfDay
            }
          }
        })
      : Promise.resolve(0)
  ]);

  const totalToday = sentToday + queuedToday;
  const progressPercent = totalToday > 0 ? Math.round((sentToday / totalToday) * 100) : 0;
  const queuedNext3Days = queuedTomorrow + queuedDay2 + queuedDay3;

  const next3DaysBreakdown = [
    { date: tomorrowStr, label: formatLabel(tomorrowDate), queued: queuedTomorrow },
    { date: day2Str, label: formatLabel(day2Date), queued: queuedDay2 },
    { date: day3Str, label: formatLabel(day3Date), queued: queuedDay3 }
  ].filter(d => d.queued > 0);

  return {
    timezone: tz,
    today: {
      date: todayStr,
      planned: totalToday,
      sent: sentToday,
      queued: queuedToday,
      progressPercent
    },
    tomorrow: {
      date: tomorrowStr,
      queued: queuedTomorrow
    },
    next3Days: {
      totalQueued: queuedNext3Days,
      days: next3DaysBreakdown
    }
  };
}

/**
 * Controller endpoint: GET /api/dashboard/sending-queue
 */
export const getSendingQueueSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const summary = await calculateSendingQueueSummary(user, prisma);
    res.status(200).json(summary);
  } catch (error) {
    console.error('Error fetching sending queue summary:', error);
    res.status(500).json({ error: 'Failed to calculate sending queue summary' });
  }
};

