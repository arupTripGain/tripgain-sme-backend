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
    currentlyEligibleQueue: 0,
    todaySendCapacity: 0,
    sentToday: 0,
    remainingTodayCapacity: 0,
    remainingSendableToday: 0,
    todaySendable: 0,
    futureQueue: 0,
    today: {
      date: todayStr,
      capacity: 0,
      planned: 0,
      sent: 0,
      sendable: 0,
      remainingSendableToday: 0,
      queued: 0,
      progressPercent: 0
    },
    tomorrow: {
      date: tomorrowStr,
      queued: 0,
      rolloverQueue: 0,
      scheduled: 0
    },
    next3Days: {
      totalQueued: 0,
      days: [] as Array<{ date: string; label: string; queued: number }>
    }
  };

  // 2. Fetch user campaigns with minimal scalar fields including daily quotas
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
      dailySendLimit: true,
      hourlySendLimit: true,
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
      currentlyEligibleQueue: 0,
      todaySendCapacity: 0,
      sentToday,
      remainingTodayCapacity: 0,
      remainingSendableToday: 0,
      todaySendable: 0,
      futureQueue: 0,
      today: {
        date: todayStr,
        capacity: 0,
        planned,
        sent: sentToday,
        sendable: 0,
        remainingSendableToday: 0,
        queued: 0,
        progressPercent
      },
      tomorrow: {
        date: tomorrowStr,
        queued: 0,
        rolloverQueue: 0,
        scheduled: 0
      },
      next3Days: {
        totalQueued: 0,
        days: []
      }
    };
  }

  // 5. Active, connected mailboxes with daily limits
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
      dailySendLimit: true,
      hourlySendLimit: true,
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
  // Track matched mailboxes per campaign to accurately compute joint campaign/mailbox quota
  const campaignMatchedMailboxesMap = new Map<string, any[]>();

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

    campaignMatchedMailboxesMap.set(camp.id, matchedMbs);

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

  const eligibleActiveCampaignsToday = activeCampaigns.filter((c: any) =>
    canSendOnDay(c.id, todayBounds.currentDayOfWeek)
  );
  const eligibleCampIdsToday = eligibleActiveCampaignsToday.map((c: any) => c.id);

  const eligibleCampIdsTomorrow = activeCampaigns
    .filter((c: any) => canSendOnDay(c.id, tomorrowBounds.currentDayOfWeek))
    .map((c: any) => c.id);

  const eligibleCampIdsDay2 = activeCampaigns
    .filter((c: any) => canSendOnDay(c.id, day2Bounds.currentDayOfWeek))
    .map((c: any) => c.id);

  const eligibleCampIdsDay3 = activeCampaigns
    .filter((c: any) => canSendOnDay(c.id, day3Bounds.currentDayOfWeek))
    .map((c: any) => c.id);

  // 7. Calculate Today's actual send capacity from active mailboxes and campaigns
  let todaySendCapacity = 0;
  if (eligibleActiveCampaignsToday.length > 0) {
    const eligibleMailboxIdsToday = new Set<string>();
    let campaignDailyQuotaSum = 0;

    for (const camp of eligibleActiveCampaignsToday) {
      campaignDailyQuotaSum += (typeof camp.dailySendLimit === 'number' ? camp.dailySendLimit : 100);
      const mbs = campaignMatchedMailboxesMap.get(camp.id) || [];
      for (const mb of mbs) {
        eligibleMailboxIdsToday.add(mb.id);
      }
    }

    const mailboxDailyQuotaSum = Array.from(eligibleMailboxIdsToday).reduce((sum, mbId) => {
      const mb = activeMailboxes.find((m: any) => m.id === mbId);
      return sum + (mb && typeof mb.dailySendLimit === 'number' ? mb.dailySendLimit : 25);
    }, 0);

    // Bounded by physical mailbox quotas and logical campaign quotas
    todaySendCapacity = eligibleMailboxIdsToday.size > 0
      ? Math.min(mailboxDailyQuotaSum, campaignDailyQuotaSum)
      : 0;
  }

  // 8. Check suppression list for user
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

  // 9. Execute targeted count queries in parallel (indexed, COUNT only, no full object hydration)
  const [currentlyEligibleQueue, queuedTomorrowScheduled, queuedDay2, queuedDay3] = await Promise.all([
    // Currently eligible queue (due on or before end of today or unassigned null nextSendAt)
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

    // Tomorrow scheduled sends (e.g. sequence follow-ups explicitly scheduled for tomorrow)
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

  // 10. Core live sending-plan calculation:
  // remainingTodayCapacity = todaySendCapacity - sentToday
  // todaySendable = MIN(currentlyEligibleQueue, remainingTodayCapacity)
  // futureQueue = currentlyEligibleQueue - todaySendable
  const remainingTodayCapacity = Math.max(0, todaySendCapacity - sentToday);
  const todaySendable = Math.min(currentlyEligibleQueue, remainingTodayCapacity);
  const futureQueue = Math.max(0, currentlyEligibleQueue - todaySendable);

  // Planned today represents the realistic sending goal (sent + sendable), NOT total campaign contacts
  const plannedToday = sentToday + todaySendable;
  const progressPercent = plannedToday > 0 ? Math.round((sentToday / plannedToday) * 100) : 0;

  // Natural rollover: any eligible queue not sent today naturally rolls into the next eligible sending day
  let rolloverTomorrow = 0;
  let rolloverDay2 = 0;
  let rolloverDay3 = 0;

  if (eligibleCampIdsTomorrow.length > 0) {
    rolloverTomorrow = futureQueue;
  } else if (eligibleCampIdsDay2.length > 0) {
    rolloverDay2 = futureQueue;
  } else if (eligibleCampIdsDay3.length > 0) {
    rolloverDay3 = futureQueue;
  }

  const tomorrowTotalQueued = rolloverTomorrow + queuedTomorrowScheduled;
  const day2TotalQueued = rolloverDay2 + queuedDay2;
  const day3TotalQueued = rolloverDay3 + queuedDay3;
  const totalQueuedNext3Days = tomorrowTotalQueued + day2TotalQueued + day3TotalQueued;

  const next3DaysBreakdown = [
    { date: tomorrowStr, label: formatLabel(tomorrowDate), queued: tomorrowTotalQueued },
    { date: day2Str, label: formatLabel(day2Date), queued: day2TotalQueued },
    { date: day3Str, label: formatLabel(day3Date), queued: day3TotalQueued }
  ].filter(d => d.queued > 0);

  return {
    timezone: tz,
    // 5 distinguished core metrics for Live Sending-Plan View:
    currentlyEligibleQueue,
    todaySendCapacity,
    sentToday,
    remainingTodayCapacity,
    remainingSendableToday: todaySendable,
    todaySendable,
    futureQueue,

    // Time-bucket structures (backward compatible):
    today: {
      date: todayStr,
      capacity: todaySendCapacity,
      planned: plannedToday,
      sent: sentToday,
      sendable: todaySendable,
      remainingSendableToday: todaySendable,
      queued: currentlyEligibleQueue,
      progressPercent
    },
    tomorrow: {
      date: tomorrowStr,
      queued: tomorrowTotalQueued,
      rolloverQueue: rolloverTomorrow,
      scheduled: queuedTomorrowScheduled
    },
    next3Days: {
      totalQueued: totalQueuedNext3Days,
      days: next3DaysBreakdown
    }
  };
}

// ---------------------------------------------------------------------
// Lightweight in-memory snapshot cache for fast 30-60s dashboard polling
// ---------------------------------------------------------------------
interface SendingQueueSnapshot {
  timestamp: number;
  data: any;
}
const queueSnapshotCache = new Map<string, SendingQueueSnapshot>();
const SNAPSHOT_TTL_MS = 30_000; // 30 seconds

export function clearSendingQueueCache(userId?: string): void {
  if (userId) {
    queueSnapshotCache.delete(userId);
  } else {
    queueSnapshotCache.clear();
  }
}

/**
 * Controller endpoint: GET /api/dashboard/sending-queue
 */
export const getSendingQueueSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const force = req.query.force === 'true' || req.query.refresh === 'true';
    const cacheKey = user.userId;
    const nowMs = Date.now();

    if (!force && queueSnapshotCache.has(cacheKey)) {
      const cached = queueSnapshotCache.get(cacheKey)!;
      if (nowMs - cached.timestamp < SNAPSHOT_TTL_MS) {
        res.status(200).json(cached.data);
        return;
      }
    }

    const summary = await calculateSendingQueueSummary(user, prisma);
    queueSnapshotCache.set(cacheKey, { timestamp: nowMs, data: summary });
    res.status(200).json(summary);
  } catch (error) {
    console.error('Error fetching sending queue summary:', error);
    res.status(500).json({ error: 'Failed to calculate sending queue summary' });
  }
};


