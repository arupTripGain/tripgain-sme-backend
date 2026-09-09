import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface CampaignAnalyticsSummary {
  totalEnrolled: number;
  sequenceStarted: number;
  sent: number;
  uniqueSent: number;
  delivered: number;
  uniqueDelivered: number;
  totalOpens: number;
  uniqueOpeners: number;
  uniqueOpenRate: number | null; // e.g. 80.0, or null if 0 delivered
  totalClicks: number;
  uniqueClickers: number;
  uniqueClickRate: number | null; // e.g. 40.0, or null if 0 delivered
  totalReplies: number;
  uniqueRepliers: number;
  replyRate: number | null;
  bounced: number;
  bounceRate: number | null;
  unsubscribed: number;
  unsubscribeRate: number | null;
}

export interface FunnelStage {
  stage: string;
  count: number;
  percentageOfSent: number;
  dropOffPercentage: number;
}

export interface ActivityTimelinePoint {
  date: string; // e.g. "Sep 9"
  isoDate: string; // "2026-09-09"
  sent: number;
  delivered: number;
  uniqueOpens: number;
  uniqueClickers: number;
  replies: number;
  totalOpens: number;
  totalClicks: number;
}

export interface StepPerformanceRow {
  stepId: string;
  stepNumber: number;
  stepType: string;
  delayDays: number;
  subject: string;
  sent: number;
  delivered: number;
  uniqueOpens: number;
  totalOpens: number;
  uniqueOpenRate: number | null;
  uniqueClicks: number;
  totalClicks: number;
  uniqueClickRate: number | null;
  replies: number;
  replyRate: number | null;
}

export interface LinkPerformanceRow {
  destinationUrl: string;
  totalClicks: number;
  uniqueClickers: number;
  firstClickedAt: Date | null;
  lastClickedAt: Date | null;
}

export type EngagementStatus = 
  | 'REPLIED'
  | 'CLICKED'
  | 'OPENED'
  | 'SENT'
  | 'NOT_SENT'
  | 'BOUNCED'
  | 'UNSUBSCRIBED';

export interface ContactEngagementRow {
  id: string;
  enrollmentId: string;
  contactId: string;
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  title: string;
  currentStep: number;
  status: string; // lead status e.g. 'active', 'completed', 'paused'
  engagementStatus: EngagementStatus;
  openCount: number;
  uniqueOpened: boolean;
  firstOpenedAt: Date | null;
  lastOpenedAt: Date | null;
  clickCount: number;
  uniqueClicked: boolean;
  firstClickedAt: Date | null;
  lastClickedAt: Date | null;
  replyCount: number;
  replied: boolean;
  firstRepliedAt: Date | null;
  lastRepliedAt: Date | null;
  lastSentAt: Date | null;
  lastActivityAt: Date | null;
  nextSendAt: Date | null;
  stopReason: string | null;
  engagement: {
    openCount: number;
    uniqueOpened: boolean;
    firstOpenedAt: Date | null;
    lastOpenedAt: Date | null;
    clickCount: number;
    uniqueClicked: boolean;
    firstClickedAt: Date | null;
    lastClickedAt: Date | null;
    replyCount: number;
    replied: boolean;
    firstRepliedAt: Date | null;
    lastRepliedAt: Date | null;
    lastActivityAt: Date | null;
    engagementStatus: EngagementStatus;
  };
}

export interface ContactTimelineEvent {
  id: string;
  type: 'SENT' | 'OPENED' | 'CLICKED' | 'REPLIED' | 'SCHEDULED' | 'BOUNCED';
  title: string;
  description: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

// Helper to sanitize CSV field
function escapeCsv(val: any): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Single centralized service for Outreach Analytics calculations.
 */
export class AnalyticsService {
  /**
   * Calculates high-level overview metrics & engagement funnel.
   */
  static async getCampaignOverview(
    campaignId: string,
    options: {
      startDate?: Date;
      endDate?: Date;
    } = {}
  ): Promise<{
    summary: CampaignAnalyticsSummary;
    funnel: FunnelStage[];
    timezone: string;
  }> {
    const messageWhere: any = {};
    if (options.startDate || options.endDate) {
      messageWhere.sentAt = {};
      if (options.startDate) messageWhere.sentAt.gte = options.startDate;
      if (options.endDate) messageWhere.sentAt.lte = options.endDate;
    }

    const eventWhere: any = {};
    if (options.startDate || options.endDate) {
      eventWhere.eventAt = {};
      if (options.startDate) eventWhere.eventAt.gte = options.startDate;
      if (options.endDate) eventWhere.eventAt.lte = options.endDate;
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        enrollments: {
          include: {
            contact: { include: { emails: true, organization: true } }
          }
        },
        messages: Object.keys(messageWhere).length > 0 ? { where: messageWhere } : true,
        events: Object.keys(eventWhere).length > 0 ? { where: eventWhere } : true
      }
    });

    if (!campaign) {
      throw new Error('Campaign not found');
    }

    const totalEnrolled = campaign.enrollments.length;

    // Outbound messages that represent actual sends
    const sentMessages = campaign.messages.filter(
      (m) => m.status === 'sent' || m.status === 'delivered'
    );
    const sentCount = sentMessages.length;

    // Unique enrolled contacts that received >= 1 send
    const sentEnrollmentIds = new Set<string>();
    sentMessages.forEach((m) => {
      if (m.enrollmentId) sentEnrollmentIds.add(m.enrollmentId);
    });
    const uniqueSent = sentEnrollmentIds.size;

    // Delivered messages: sent messages not marked as bounced
    const bouncedMessages = campaign.messages.filter((m) => m.status === 'bounced');
    const bouncedEnrollmentIds = new Set<string>();
    bouncedMessages.forEach((m) => {
      if (m.enrollmentId) bouncedEnrollmentIds.add(m.enrollmentId);
    });

    // Also include bounce events
    campaign.events
      .filter((e) => e.eventType === 'bounced' || e.eventType === 'email.bounced')
      .forEach((e) => {
        if (e.enrollmentId) bouncedEnrollmentIds.add(e.enrollmentId);
      });

    const uniqueBounced = bouncedEnrollmentIds.size;
    const deliveredCount = Math.max(0, sentCount - bouncedMessages.length);
    const uniqueDelivered = Math.max(0, uniqueSent - uniqueBounced);

    // Sequence started = contacts with lastSentAt OR non-pending status
    const sequenceStarted = campaign.enrollments.filter(
      (e) => e.lastSentAt || ['active', 'replied', 'completed', 'bounced'].includes(e.status)
    ).length;

    // Events breakdown
    const openEvents = campaign.events.filter(
      (e) => e.eventType === 'opened' || e.eventType === 'email.opened'
    );
    const uniqueOpenerIds = new Set<string>();
    openEvents.forEach((e) => {
      if (e.enrollmentId) uniqueOpenerIds.add(e.enrollmentId);
    });
    const totalOpens = openEvents.length;
    const uniqueOpeners = uniqueOpenerIds.size;

    const clickEvents = campaign.events.filter(
      (e) => e.eventType === 'clicked' || e.eventType === 'email.clicked'
    );
    const uniqueClickerIds = new Set<string>();
    clickEvents.forEach((e) => {
      if (e.enrollmentId) uniqueClickerIds.add(e.enrollmentId);
    });
    const totalClicks = clickEvents.length;
    const uniqueClickers = uniqueClickerIds.size;

    // Replies: from events and enrollment status
    const replyEvents = campaign.events.filter(
      (e) => e.eventType === 'replied' || e.eventType === 'email.replied'
    );
    const uniqueReplierIds = new Set<string>();
    replyEvents.forEach((e) => {
      if (e.enrollmentId) uniqueReplierIds.add(e.enrollmentId);
    });
    campaign.enrollments
      .filter((e) => e.status === 'replied')
      .forEach((e) => uniqueReplierIds.add(e.id));

    const totalReplies = Math.max(replyEvents.length, uniqueReplierIds.size);
    const uniqueRepliers = uniqueReplierIds.size;

    // Unsubscribes
    const unsubEvents = campaign.events.filter(
      (e) => e.eventType === 'unsubscribed' || e.eventType === 'email.unsubscribed'
    );
    const unsubscriberIds = new Set<string>();
    unsubEvents.forEach((e) => {
      if (e.enrollmentId) unsubscriberIds.add(e.enrollmentId);
    });
    campaign.enrollments
      .filter((e) => e.status === 'unsubscribed')
      .forEach((e) => unsubscriberIds.add(e.id));
    const uniqueUnsubscribed = unsubscriberIds.size;

    // Formula calculation: strictly based on unique delivered contacts
    const uniqueOpenRate =
      uniqueDelivered > 0
        ? Math.min(100, Number(((uniqueOpeners / uniqueDelivered) * 100).toFixed(1)))
        : null;

    const uniqueClickRate =
      uniqueDelivered > 0
        ? Math.min(100, Number(((uniqueClickers / uniqueDelivered) * 100).toFixed(1)))
        : null;

    const replyRate =
      uniqueDelivered > 0
        ? Math.min(100, Number(((uniqueRepliers / uniqueDelivered) * 100).toFixed(1)))
        : null;

    const bounceRate =
      uniqueSent > 0
        ? Math.min(100, Number(((uniqueBounced / uniqueSent) * 100).toFixed(1)))
        : null;

    const unsubscribeRate =
      uniqueDelivered > 0
        ? Math.min(100, Number(((uniqueUnsubscribed / uniqueDelivered) * 100).toFixed(1)))
        : null;

    // 5-Stage Unique Person Engagement Funnel
    // Sent -> Delivered -> Opened -> Clicked -> Replied
    const baseSent = Math.max(uniqueSent, 1);
    const fDeliveredPct = uniqueSent > 0 ? Number(((uniqueDelivered / uniqueSent) * 100).toFixed(1)) : 0;
    const fOpenedPct = uniqueSent > 0 ? Number(((uniqueOpeners / uniqueSent) * 100).toFixed(1)) : 0;
    const fClickedPct = uniqueSent > 0 ? Number(((uniqueClickers / uniqueSent) * 100).toFixed(1)) : 0;
    const fRepliedPct = uniqueSent > 0 ? Number(((uniqueRepliers / uniqueSent) * 100).toFixed(1)) : 0;

    const funnel: FunnelStage[] = [
      {
        stage: 'Sent',
        count: uniqueSent,
        percentageOfSent: 100,
        dropOffPercentage: 0
      },
      {
        stage: 'Delivered',
        count: uniqueDelivered,
        percentageOfSent: fDeliveredPct,
        dropOffPercentage: uniqueSent > 0 ? Math.max(0, Number((((uniqueSent - uniqueDelivered) / uniqueSent) * 100).toFixed(1))) : 0
      },
      {
        stage: 'Opened',
        count: uniqueOpeners,
        percentageOfSent: fOpenedPct,
        dropOffPercentage: uniqueDelivered > 0 ? Math.max(0, Number((((uniqueDelivered - uniqueOpeners) / uniqueDelivered) * 100).toFixed(1))) : 0
      },
      {
        stage: 'Clicked',
        count: uniqueClickers,
        percentageOfSent: fClickedPct,
        dropOffPercentage: uniqueOpeners > 0 ? Math.max(0, Number((((uniqueOpeners - uniqueClickers) / uniqueOpeners) * 100).toFixed(1))) : 0
      },
      {
        stage: 'Replied',
        count: uniqueRepliers,
        percentageOfSent: fRepliedPct,
        dropOffPercentage: uniqueClickers > 0 ? Math.max(0, Number((((uniqueClickers - uniqueRepliers) / uniqueClickers) * 100).toFixed(1))) : 0
      }
    ];

    return {
      summary: {
        totalEnrolled,
        sequenceStarted,
        sent: sentCount,
        uniqueSent,
        delivered: deliveredCount,
        uniqueDelivered,
        totalOpens,
        uniqueOpeners,
        uniqueOpenRate,
        totalClicks,
        uniqueClickers,
        uniqueClickRate,
        totalReplies,
        uniqueRepliers,
        replyRate,
        bounced: uniqueBounced,
        bounceRate,
        unsubscribed: uniqueUnsubscribed,
        unsubscribeRate
      },
      funnel,
      timezone: campaign.timezone || 'Asia/Kolkata'
    };
  }

  /**
   * Generates time-bucketed activity chart data in campaign timezone.
   */
  static async getCampaignActivityTimeline(
    campaignId: string,
    days: number = 7,
    timeZone: string = 'Asia/Kolkata'
  ): Promise<ActivityTimelinePoint[]> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        messages: true,
        events: true
      }
    });

    if (!campaign) throw new Error('Campaign not found');

    const timeline: ActivityTimelinePoint[] = [];
    const now = new Date();

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);

      // Local calendar boundaries for the date in target timezone
      const year = d.getFullYear();
      const month = d.getMonth();
      const day = d.getDate();

      const dayStart = new Date(year, month, day, 0, 0, 0, 0);
      const dayEnd = new Date(year, month, day, 23, 59, 59, 999);

      const label = d.toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric' });
      const isoDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

      // Sent messages in this day
      const daySentMsgs = campaign.messages.filter((m) => {
        const t = m.sentAt || m.createdAt;
        return t && t >= dayStart && t <= dayEnd && (m.status === 'sent' || m.status === 'delivered');
      });

      const dayDeliveredMsgs = daySentMsgs.filter((m) => m.status !== 'bounced');

      // Unique openers on this day
      const dayOpenEvents = campaign.events.filter((e) => {
        const t = e.eventAt || e.createdAt;
        return t && t >= dayStart && t <= dayEnd && (e.eventType === 'opened' || e.eventType === 'email.opened');
      });
      const dayUniqueOpeners = new Set<string>();
      dayOpenEvents.forEach((e) => {
        if (e.enrollmentId) dayUniqueOpeners.add(e.enrollmentId);
      });

      // Unique clickers on this day
      const dayClickEvents = campaign.events.filter((e) => {
        const t = e.eventAt || e.createdAt;
        return t && t >= dayStart && t <= dayEnd && (e.eventType === 'clicked' || e.eventType === 'email.clicked');
      });
      const dayUniqueClickers = new Set<string>();
      dayClickEvents.forEach((e) => {
        if (e.enrollmentId) dayUniqueClickers.add(e.enrollmentId);
      });

      // Replies on this day
      const dayReplyEvents = campaign.events.filter((e) => {
        const t = e.eventAt || e.createdAt;
        return t && t >= dayStart && t <= dayEnd && (e.eventType === 'replied' || e.eventType === 'email.replied');
      });
      const dayUniqueReplies = new Set<string>();
      dayReplyEvents.forEach((e) => {
        if (e.enrollmentId) dayUniqueReplies.add(e.enrollmentId);
      });

      timeline.push({
        date: label,
        isoDate,
        sent: daySentMsgs.length,
        delivered: dayDeliveredMsgs.length,
        uniqueOpens: dayUniqueOpeners.size,
        uniqueClickers: dayUniqueClickers.size,
        replies: dayUniqueReplies.size,
        totalOpens: dayOpenEvents.length,
        totalClicks: dayClickEvents.length
      });
    }

    return timeline;
  }

  /**
   * Computes sequence step conversion performance.
   */
  static async getCampaignStepPerformance(campaignId: string): Promise<StepPerformanceRow[]> {
    const sequence = await prisma.sequence.findFirst({
      where: { campaignId },
      include: {
        steps: { orderBy: { stepNumber: 'asc' } }
      }
    });

    if (!sequence || sequence.steps.length === 0) {
      return [];
    }

    const messages = await prisma.emailMessage.findMany({
      where: { campaignId, status: { in: ['sent', 'delivered', 'bounced'] } },
      include: { events: true }
    });

    const rows: StepPerformanceRow[] = [];

    for (const step of sequence.steps) {
      const stepMessages = messages.filter((m) => m.sequenceStepId === step.id);
      const sent = stepMessages.length;
      const bounced = stepMessages.filter((m) => m.status === 'bounced').length;
      const delivered = Math.max(0, sent - bounced);

      const openEvents = stepMessages.flatMap((m) =>
        m.events.filter((e) => e.eventType === 'opened' || e.eventType === 'email.opened')
      );
      const uniqueOpenerIds = new Set<string>();
      openEvents.forEach((e) => {
        if (e.enrollmentId) uniqueOpenerIds.add(e.enrollmentId);
      });
      const uniqueOpens = uniqueOpenerIds.size;
      const totalOpens = openEvents.length;

      const clickEvents = stepMessages.flatMap((m) =>
        m.events.filter((e) => e.eventType === 'clicked' || e.eventType === 'email.clicked')
      );
      const uniqueClickerIds = new Set<string>();
      clickEvents.forEach((e) => {
        if (e.enrollmentId) uniqueClickerIds.add(e.enrollmentId);
      });
      const uniqueClicks = uniqueClickerIds.size;
      const totalClicks = clickEvents.length;

      const replyEvents = stepMessages.flatMap((m) =>
        m.events.filter((e) => e.eventType === 'replied' || e.eventType === 'email.replied')
      );
      const uniqueReplierIds = new Set<string>();
      replyEvents.forEach((e) => {
        if (e.enrollmentId) uniqueReplierIds.add(e.enrollmentId);
      });
      const replies = uniqueReplierIds.size;

      const uniqueOpenRate = delivered > 0 ? Number(((uniqueOpens / delivered) * 100).toFixed(1)) : null;
      const uniqueClickRate = delivered > 0 ? Number(((uniqueClicks / delivered) * 100).toFixed(1)) : null;
      const replyRate = delivered > 0 ? Number(((replies / delivered) * 100).toFixed(1)) : null;

      rows.push({
        stepId: step.id,
        stepNumber: step.stepNumber,
        stepType: step.stepType || 'email',
        delayDays: step.delayDays,
        subject: step.subjectTemplate || '(Reply in thread)',
        sent,
        delivered,
        uniqueOpens,
        totalOpens,
        uniqueOpenRate,
        uniqueClicks,
        totalClicks,
        uniqueClickRate,
        replies,
        replyRate
      });
    }

    return rows;
  }

  /**
   * Computes tracked destination link performance.
   */
  static async getCampaignLinkPerformance(campaignId: string): Promise<LinkPerformanceRow[]> {
    const emailLinks = await prisma.emailLink.findMany({
      where: {
        message: { campaignId }
      },
      include: {
        events: true,
        message: true
      }
    });

    const urlMap = new Map<
      string,
      {
        totalClicks: number;
        uniqueClickers: Set<string>;
        firstClickedAt: Date | null;
        lastClickedAt: Date | null;
      }
    >();

    for (const link of emailLinks) {
      const url = link.destinationUrl;
      if (!urlMap.has(url)) {
        urlMap.set(url, {
          totalClicks: 0,
          uniqueClickers: new Set(),
          firstClickedAt: null,
          lastClickedAt: null
        });
      }

      const entry = urlMap.get(url)!;
      entry.totalClicks += link.clickCount || 0;

      const clickEvents = link.events.filter(
        (e) => e.eventType === 'clicked' || e.eventType === 'email.clicked'
      );

      clickEvents.forEach((ev) => {
        const contactIdentifier = ev.enrollmentId || ev.contactId || link.message?.toEmail || 'unknown';
        entry.uniqueClickers.add(contactIdentifier);

        const evTime = ev.eventAt || ev.createdAt;
        if (!entry.firstClickedAt || evTime < entry.firstClickedAt) {
          entry.firstClickedAt = evTime;
        }
        if (!entry.lastClickedAt || evTime > entry.lastClickedAt) {
          entry.lastClickedAt = evTime;
        }
      });
    }

    return Array.from(urlMap.entries()).map(([destinationUrl, data]) => ({
      destinationUrl,
      totalClicks: data.totalClicks,
      uniqueClickers: data.uniqueClickers.size,
      firstClickedAt: data.firstClickedAt,
      lastClickedAt: data.lastClickedAt
    }));
  }

  /**
   * Evaluates enrollment-level engagement with derived status and filtering.
   */
  static async getCampaignContactEngagement(
    campaignId: string,
    filter: string = 'ALL'
  ): Promise<ContactEngagementRow[]> {
    const enrollments = await prisma.enrollment.findMany({
      where: { campaignId },
      include: {
        contact: { include: { emails: true, organization: true } },
        messages: {
          orderBy: { sentAt: 'desc' }
        },
        events: {
          orderBy: { eventAt: 'asc' }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const rows: ContactEngagementRow[] = enrollments.map((enr) => {
      const contact = enr.contact;
      const primaryEmail =
        contact?.emails?.find((e) => e.isPrimary)?.email ||
        contact?.emails?.[0]?.email ||
        'unknown@example.com';

      const openEvents = enr.events.filter(
        (e) => e.eventType === 'opened' || e.eventType === 'email.opened'
      );
      const clickEvents = enr.events.filter(
        (e) => e.eventType === 'clicked' || e.eventType === 'email.clicked'
      );
      const replyEvents = enr.events.filter(
        (e) => e.eventType === 'replied' || e.eventType === 'email.replied'
      );

      const openCount = openEvents.length;
      const uniqueOpened = openCount > 0;
      const firstOpenedAt = openEvents[0]?.eventAt || null;
      const lastOpenedAt = (openEvents.length > 0 ? openEvents[openEvents.length - 1]?.eventAt : null) ?? null;

      const clickCount = clickEvents.length;
      const uniqueClicked = clickCount > 0;
      const firstClickedAt = clickEvents[0]?.eventAt || null;
      const lastClickedAt = (clickEvents.length > 0 ? clickEvents[clickEvents.length - 1]?.eventAt : null) ?? null;

      const replyCount = Math.max(replyEvents.length, enr.status === 'replied' ? 1 : 0);
      const replied = replyCount > 0;
      const firstRepliedAt = replyEvents[0]?.eventAt || null;
      const lastRepliedAt = (replyEvents.length > 0 ? replyEvents[replyEvents.length - 1]?.eventAt : null) ?? null;

      // Find the latest activity timestamp
      const timestamps = [
        enr.lastSentAt,
        lastOpenedAt,
        lastClickedAt,
        lastRepliedAt
      ].filter((t): t is Date => t !== null && t !== undefined);

      const lastActivityAt =
        timestamps.length > 0
          ? new Date(Math.max(...timestamps.map((t) => t.getTime())))
          : null;

      // Derived engagement state:
      // Priority: REPLIED > CLICKED > OPENED > SENT > NOT_SENT (plus BOUNCED, UNSUBSCRIBED)
      let engagementStatus: EngagementStatus = 'NOT_SENT';
      if (enr.status === 'bounced') {
        engagementStatus = 'BOUNCED';
      } else if (enr.status === 'unsubscribed') {
        engagementStatus = 'UNSUBSCRIBED';
      } else if (replied) {
        engagementStatus = 'REPLIED';
      } else if (uniqueClicked) {
        engagementStatus = 'CLICKED';
      } else if (uniqueOpened) {
        engagementStatus = 'OPENED';
      } else if (enr.lastSentAt || enr.messages.length > 0) {
        engagementStatus = 'SENT';
      }

      return {
        id: enr.id,
        enrollmentId: enr.id,
        contactId: enr.contactId,
        fullName: contact?.fullName || `${contact?.firstName || ''} ${contact?.lastName || ''}`.trim() || primaryEmail,
        firstName: contact?.firstName || '',
        lastName: contact?.lastName || '',
        email: primaryEmail,
        company: contact?.organization?.name || '',
        title: contact?.jobTitle || '',
        currentStep: enr.currentStep,
        status: enr.status,
        engagementStatus,
        openCount,
        uniqueOpened,
        firstOpenedAt,
        lastOpenedAt,
        clickCount,
        uniqueClicked,
        firstClickedAt,
        lastClickedAt,
        replyCount,
        replied,
        firstRepliedAt,
        lastRepliedAt,
        lastSentAt: enr.lastSentAt || null,
        lastActivityAt,
        nextSendAt: enr.nextSendAt || null,
        stopReason: enr.stopReason || null,
        engagement: {
          openCount,
          uniqueOpened,
          firstOpenedAt,
          lastOpenedAt,
          clickCount,
          uniqueClicked,
          firstClickedAt,
          lastClickedAt,
          replyCount,
          replied,
          firstRepliedAt,
          lastRepliedAt,
          lastActivityAt,
          engagementStatus
        }
      };
    });

    // Filtering logic
    const filterUpper = filter.toUpperCase();
    if (filterUpper === 'ALL') return rows;
    if (filterUpper === 'OPENED') return rows.filter((r) => r.uniqueOpened);
    if (filterUpper === 'NOT_OPENED') return rows.filter((r) => !r.uniqueOpened && r.engagementStatus === 'SENT');
    if (filterUpper === 'CLICKED') return rows.filter((r) => r.uniqueClicked);
    if (filterUpper === 'REPLIED') return rows.filter((r) => r.replied);
    if (filterUpper === 'BOUNCED') return rows.filter((r) => r.engagementStatus === 'BOUNCED');
    if (filterUpper === 'UNSUBSCRIBED') return rows.filter((r) => r.engagementStatus === 'UNSUBSCRIBED');
    if (filterUpper === 'HIGH_ENGAGEMENT') return rows.filter((r) => r.uniqueClicked || r.replied);
    if (filterUpper === 'NO_ENGAGEMENT') return rows.filter((r) => r.engagementStatus === 'SENT' && !r.uniqueOpened);

    return rows;
  }

  /**
   * Retrieves full chronological timeline of outreach interactions for an individual contact.
   */
  static async getContactActivityTimeline(
    campaignId: string,
    enrollmentId: string
  ): Promise<{
    contact: any;
    enrollment?: any;
    engagement: ContactEngagementRow | null;
    messages?: any[];
    events: ContactTimelineEvent[];
  }> {
    const enrollment = await prisma.enrollment.findFirst({
      where: { id: enrollmentId, campaignId },
      include: {
        contact: { include: { emails: true, organization: true } },
        messages: {
          include: { sequenceStep: true },
          orderBy: { sentAt: 'asc' }
        },
        events: {
          include: { link: true },
          orderBy: { eventAt: 'asc' }
        }
      }
    });

    if (!enrollment) {
      throw new Error('Enrollment not found');
    }

    const engagementRows = await this.getCampaignContactEngagement(campaignId, 'ALL');
    const engagement = engagementRows.find((r) => r.enrollmentId === enrollmentId) || null;

    const timelineEvents: ContactTimelineEvent[] = [];

    // Message sent events
    for (const msg of enrollment.messages) {
      if (msg.sentAt) {
        timelineEvents.push({
          id: `msg-${msg.id}`,
          type: 'SENT',
          title: `Step ${msg.sequenceStep?.stepNumber || 1} Email Sent`,
          description: `Subject: "${msg.subject || '(No subject)'}" via ${msg.fromEmail}`,
          timestamp: msg.sentAt,
          metadata: {
            messageId: msg.id,
            stepNumber: msg.sequenceStep?.stepNumber || 1,
            fromEmail: msg.fromEmail
          }
        });
      }
    }

    // Tracking events
    for (const ev of enrollment.events) {
      const evDate = ev.eventAt || ev.createdAt;
      if (ev.eventType === 'opened' || ev.eventType === 'email.opened') {
        timelineEvents.push({
          id: `ev-${ev.id}`,
          type: 'OPENED',
          title: 'Tracked Email Open',
          description: 'Recipient opened the email message.',
          timestamp: evDate
        });
      } else if (ev.eventType === 'clicked' || ev.eventType === 'email.clicked') {
        const destUrl = ev.link?.destinationUrl || (ev.metadata as any)?.destinationUrl || 'Tracked link';
        timelineEvents.push({
          id: `ev-${ev.id}`,
          type: 'CLICKED',
          title: 'Link Clicked',
          description: `Clicked destination: ${destUrl}`,
          timestamp: evDate,
          metadata: { destinationUrl: destUrl }
        });
      } else if (ev.eventType === 'replied' || ev.eventType === 'email.replied') {
        timelineEvents.push({
          id: `ev-${ev.id}`,
          type: 'REPLIED',
          title: 'Reply Received',
          description: 'Recipient sent an inbound response.',
          timestamp: evDate
        });
      } else if (ev.eventType === 'bounced' || ev.eventType === 'email.bounced') {
        timelineEvents.push({
          id: `ev-${ev.id}`,
          type: 'BOUNCED',
          title: 'Email Bounced',
          description: 'Outbound delivery failed.',
          timestamp: evDate
        });
      }
    }

    // Scheduled next send if active
    if (enrollment.status === 'active' && enrollment.nextSendAt) {
      timelineEvents.push({
        id: `sched-${enrollment.id}`,
        type: 'SCHEDULED',
        title: `Step ${enrollment.currentStep} Scheduled`,
        description: `Automated dispatch scheduled for ${enrollment.nextSendAt.toISOString()}`,
        timestamp: enrollment.nextSendAt
      });
    }

    // Sort chronologically
    timelineEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    return {
      contact: enrollment.contact,
      enrollment: {
        id: enrollment.id,
        currentStep: enrollment.currentStep,
        status: enrollment.status,
        stopReason: enrollment.stopReason,
        nextSendAt: enrollment.nextSendAt,
        lastSentAt: enrollment.lastSentAt
      },
      engagement,
      messages: enrollment.messages,
      events: timelineEvents
    };
  }

  /**
   * Generates a sanitized CSV export containing all 22 required outreach engagement columns.
   */
  static async exportCampaignAnalyticsCsv(campaignId: string): Promise<string> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { name: true }
    });
    const campaignName = campaign?.name || 'Campaign';

    const contacts = await this.getCampaignContactEngagement(campaignId, 'ALL');

    const headers = [
      'Contact Name',
      'Email',
      'Company',
      'Campaign',
      'Sequence Step',
      'Sent At',
      'Delivered At',
      'Unique Opened',
      'Open Count',
      'First Opened At',
      'Last Opened At',
      'Unique Clicked',
      'Click Count',
      'First Clicked At',
      'Last Clicked At',
      'Replied',
      'Reply Count',
      'First Replied At',
      'Last Replied At',
      'Bounce Status',
      'Unsubscribe Status',
      'Last Activity At'
    ];

    const lines: string[] = [headers.join(',')];

    for (const c of contacts) {
      const row = [
        escapeCsv(c.fullName),
        escapeCsv(c.email),
        escapeCsv(c.company),
        escapeCsv(campaignName),
        escapeCsv(`Step ${c.currentStep}`),
        escapeCsv(c.lastSentAt?.toISOString() || ''),
        escapeCsv(c.lastSentAt ? c.lastSentAt.toISOString() : ''), // Delivered
        escapeCsv(c.uniqueOpened ? 'YES' : 'NO'),
        escapeCsv(c.openCount),
        escapeCsv(c.firstOpenedAt?.toISOString() || ''),
        escapeCsv(c.lastOpenedAt?.toISOString() || ''),
        escapeCsv(c.uniqueClicked ? 'YES' : 'NO'),
        escapeCsv(c.clickCount),
        escapeCsv(c.firstClickedAt?.toISOString() || ''),
        escapeCsv(c.lastClickedAt?.toISOString() || ''),
        escapeCsv(c.replied ? 'YES' : 'NO'),
        escapeCsv(c.replyCount),
        escapeCsv(c.firstRepliedAt?.toISOString() || ''),
        escapeCsv(c.lastRepliedAt?.toISOString() || ''),
        escapeCsv(c.engagementStatus === 'BOUNCED' ? 'BOUNCED' : 'NONE'),
        escapeCsv(c.engagementStatus === 'UNSUBSCRIBED' ? 'UNSUBSCRIBED' : 'ACTIVE'),
        escapeCsv(c.lastActivityAt?.toISOString() || '')
      ];
      lines.push(row.join(','));
    }

    return lines.join('\n');
  }
}
