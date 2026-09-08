import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface CalendarBucketBounds {
  startOfHour: Date;
  endOfHour: Date;
  startOfDay: Date;
  endOfDay: Date;
  currentDayOfWeek: string; // e.g. "MON"
  currentTimeString: string; // e.g. "11:45:00"
  timeZone: string;
}

/**
 * Derives UTC Date bounds for the current calendar hour and calendar day
 * based on a specific target timezone (e.g. "Asia/Kolkata").
 */
export function getCalendarBucketBounds(date: Date = new Date(), targetTimeZone: string = 'Asia/Kolkata'): CalendarBucketBounds {
  const timeZone = targetTimeZone || 'Asia/Kolkata';

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') partMap[p.type] = p.value;
  }

  const year = parseInt(partMap.year || '1970', 10);
  const month = parseInt(partMap.month || '1', 10);
  const day = parseInt(partMap.day || '1', 10);
  const hour = parseInt(partMap.hour || '0', 10);
  const currentDayOfWeek = (partMap.weekday || '').toUpperCase();
  const currentTimeString = `${partMap.hour}:${partMap.minute}:${partMap.second}`;

  // Helper to construct UTC Date for a local YYYY-MM-DD HH:mm:ss in target timeZone
  // We determine timezone offset at this exact instant:
  const localDateForOffset = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
  const diffMinutes = getTimezoneOffsetMinutes(localDateForOffset, timeZone);

  // UTC equivalent = localTime - offset
  const startOfHour = new Date(Date.UTC(year, month - 1, day, hour, 0, 0, 0) - diffMinutes * 60000);
  const endOfHour = new Date(startOfHour.getTime() + 3600000);

  const startOfDay = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - diffMinutes * 60000);
  const endOfDay = new Date(startOfDay.getTime() + 86400000);

  return {
    startOfHour,
    endOfHour,
    startOfDay,
    endOfDay,
    currentDayOfWeek,
    currentTimeString,
    timeZone
  };
}

/**
 * Returns timezone offset in minutes from UTC for given date in specified timezone
 */
function getTimezoneOffsetMinutes(date: Date, timeZone: string): number {
  const invDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const targetDate = new Date(date.toLocaleString('en-US', { timeZone }));
  return Math.round((targetDate.getTime() - invDate.getTime()) / 60000);
}

/**
 * Validates whether current instant is within allowed sendingDays and sendingStartTime-sendingEndTime
 */
export function isWithinSendingWindow(
  mailbox: {
    sendingDays?: any;
    sendingStartTime?: string | null;
    sendingEndTime?: string | null;
    sendingTimezone?: string | null;
  },
  now: Date = new Date()
): { inWindow: boolean; reason?: string } {
  const bounds = getCalendarBucketBounds(now, mailbox.sendingTimezone || 'Asia/Kolkata');

  let days = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
  if (Array.isArray(mailbox.sendingDays)) {
    days = mailbox.sendingDays.map(d => String(d).toUpperCase());
  } else if (typeof mailbox.sendingDays === 'string') {
    try {
      const parsed = JSON.parse(mailbox.sendingDays);
      if (Array.isArray(parsed)) days = parsed.map(d => String(d).toUpperCase());
    } catch (_) {}
  }

  if (!days.includes(bounds.currentDayOfWeek)) {
    return {
      inWindow: false,
      reason: `OUTSIDE_SENDING_WINDOW: Day ${bounds.currentDayOfWeek} is not in allowed days (${days.join(',')})`
    };
  }

  const start = (mailbox.sendingStartTime || '09:30:00').trim().padEnd(8, ':00');
  const end = (mailbox.sendingEndTime || '19:30:00').trim().padEnd(8, ':00');

  if (bounds.currentTimeString < start || bounds.currentTimeString > end) {
    return {
      inWindow: false,
      reason: `OUTSIDE_SENDING_WINDOW: Time ${bounds.currentTimeString} is outside window [${start} - ${end}] (${bounds.timeZone})`
    };
  }

  return { inWindow: true };
}

/**
 * Ground-Truth Sent Message Calculation
 * Only successfully dispatched outbound messages count.
 * Engagement statuses (delivered, opened, clicked) do NOT double-count.
 */
export async function getDispatchedMessageCounts(params: {
  mailboxEmail: string;
  campaignId?: string | null;
  startOfHour: Date;
  endOfHour: Date;
  startOfDay: Date;
  endOfDay: Date;
}): Promise<{
  mailboxSentThisHour: number;
  mailboxSentToday: number;
  campaignSentThisHour: number;
  campaignSentToday: number;
}> {
  const validStatuses = ['sent', 'delivered', 'opened', 'clicked', 'bounced'];

  // 1. Mailbox sends: All EmailMessage sent from this mailbox + any standalone manual ConversationMessage (e.g. test emails or Unibox replies)
  const [
    mailboxCampaignHour,
    mailboxCampaignDay,
    mailboxDirectHour,
    mailboxDirectDay
  ] = await Promise.all([
    // EmailMessage in current hour
    prisma.emailMessage.count({
      where: {
        fromEmail: { equals: params.mailboxEmail, mode: 'insensitive' },
        status: { in: validStatuses },
        sentAt: { gte: params.startOfHour, lt: params.endOfHour }
      }
    }),
    // EmailMessage in current day
    prisma.emailMessage.count({
      where: {
        fromEmail: { equals: params.mailboxEmail, mode: 'insensitive' },
        status: { in: validStatuses },
        sentAt: { gte: params.startOfDay, lt: params.endOfDay }
      }
    }),
    // ConversationMessage without emailMessageId (manual replies or test emails) in current hour
    prisma.conversationMessage.count({
      where: {
        senderEmail: { equals: params.mailboxEmail, mode: 'insensitive' },
        direction: 'OUTBOUND',
        emailMessageId: null,
        sentAt: { gte: params.startOfHour, lt: params.endOfHour }
      }
    }),
    // ConversationMessage without emailMessageId in current day
    prisma.conversationMessage.count({
      where: {
        senderEmail: { equals: params.mailboxEmail, mode: 'insensitive' },
        direction: 'OUTBOUND',
        emailMessageId: null,
        sentAt: { gte: params.startOfDay, lt: params.endOfDay }
      }
    })
  ]);

  const mailboxSentThisHour = mailboxCampaignHour + mailboxDirectHour;
  const mailboxSentToday = mailboxCampaignDay + mailboxDirectDay;

  // 2. Campaign sends (if campaignId is provided)
  let campaignSentThisHour = 0;
  let campaignSentToday = 0;

  if (params.campaignId) {
    const [campHour, campDay] = await Promise.all([
      prisma.emailMessage.count({
        where: {
          campaignId: params.campaignId,
          status: { in: validStatuses },
          sentAt: { gte: params.startOfHour, lt: params.endOfHour }
        }
      }),
      prisma.emailMessage.count({
        where: {
          campaignId: params.campaignId,
          status: { in: validStatuses },
          sentAt: { gte: params.startOfDay, lt: params.endOfDay }
        }
      })
    ]);
    campaignSentThisHour = campHour;
    campaignSentToday = campDay;
  }

  return {
    mailboxSentThisHour,
    mailboxSentToday,
    campaignSentThisHour,
    campaignSentToday
  };
}

/**
 * Two-tier hierarchical capacity calculation
 */
export function calculateEffectiveCapacity(params: {
  mailboxHourlyLimit: number;
  mailboxDailyLimit: number;
  mailboxSentThisHour: number;
  mailboxSentToday: number;
  campaignHourlyLimit?: number | null;
  campaignDailyLimit?: number | null;
  campaignSentThisHour?: number;
  campaignSentToday?: number;
}): {
  availableCapacity: number;
  skipReason: string | null;
  mailboxRemainingHourly: number;
  mailboxRemainingDaily: number;
  campaignRemainingHourly: number;
  campaignRemainingDaily: number;
} {
  const mailboxRemainingHourly = Math.max(0, params.mailboxHourlyLimit - params.mailboxSentThisHour);
  const mailboxRemainingDaily = Math.max(0, params.mailboxDailyLimit - params.mailboxSentToday);

  const campaignHourlyLimit = params.campaignHourlyLimit ?? 999999;
  const campaignDailyLimit = params.campaignDailyLimit ?? 999999;
  const campaignSentThisHour = params.campaignSentThisHour ?? 0;
  const campaignSentToday = params.campaignSentToday ?? 0;

  const campaignRemainingHourly = Math.max(0, campaignHourlyLimit - campaignSentThisHour);
  const campaignRemainingDaily = Math.max(0, campaignDailyLimit - campaignSentToday);

  let skipReason: string | null = null;
  if (mailboxRemainingHourly <= 0) skipReason = 'MAILBOX_HOURLY_LIMIT';
  else if (mailboxRemainingDaily <= 0) skipReason = 'MAILBOX_DAILY_LIMIT';
  else if (campaignRemainingHourly <= 0) skipReason = 'CAMPAIGN_HOURLY_LIMIT';
  else if (campaignRemainingDaily <= 0) skipReason = 'CAMPAIGN_DAILY_LIMIT';

  const availableCapacity = Math.min(
    mailboxRemainingHourly,
    mailboxRemainingDaily,
    campaignRemainingHourly,
    campaignRemainingDaily
  );

  return {
    availableCapacity,
    skipReason,
    mailboxRemainingHourly,
    mailboxRemainingDaily,
    campaignRemainingHourly,
    campaignRemainingDaily
  };
}

/**
 * Database-backed advisory lock for concurrency protection per Mailbox.
 * Guarantees that two concurrent scheduler workers or manual ticks cannot process the same mailbox simultaneously.
 */
export async function tryAcquireMailboxLock(mailboxId: string): Promise<boolean> {
  try {
    const lockKey = hashStringTo32BitInt(`mailbox_lock:${mailboxId}`);
    const result = await prisma.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(${lockKey}) as locked
    `;
    return Boolean(result[0]?.locked);
  } catch (err) {
    console.error(`[QuotaService] Error acquiring lock for mailbox ${mailboxId}:`, err);
    return false;
  }
}

export async function releaseMailboxLock(mailboxId: string): Promise<void> {
  try {
    const lockKey = hashStringTo32BitInt(`mailbox_lock:${mailboxId}`);
    await prisma.$queryRaw`
      SELECT pg_advisory_unlock(${lockKey})
    `;
  } catch (err) {
    console.error(`[QuotaService] Error releasing lock for mailbox ${mailboxId}:`, err);
  }
}

export function hashStringTo32BitInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
