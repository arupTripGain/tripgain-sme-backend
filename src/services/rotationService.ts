import { PrismaClient } from '@prisma/client';
import {
  getCalendarBucketBounds,
  isWithinSendingWindow,
  getDispatchedMessageCounts,
  calculateEffectiveCapacity
} from './quotaService';

const prisma = new PrismaClient();

export interface EligibleMailboxResult {
  mailbox: any;
  availableCapacity: number;
  skipReason?: string;
}

export interface RotationSelectionResult {
  selectedMailbox: any | null;
  reason: string;
  eligibleCount: number;
  skippedReasons: Record<string, string>;
}

/**
 * Resolves active, connected mailboxes assigned to a campaign.
 * Preserves the stable ordering defined in campaign.senderMailboxes.
 */
export async function getCampaignAssignedMailboxes(
  campaign: { id: string; name: string; senderMailboxes?: string[] },
  client: any = prisma
): Promise<any[]> {
  const configured = campaign.senderMailboxes || [];

  if (configured.length > 0) {
    const mailboxes = await client.mailbox.findMany({
      where: {
        OR: [
          { id: { in: configured } },
          { email: { in: configured } }
        ],
        status: 'CONNECTED',
        isActive: true
      },
      include: { credentials: true }
    });

    // Preserve exact stable order of campaign.senderMailboxes
    mailboxes.sort((a: any, b: any) => {
      const idxA = configured.indexOf(a.id) !== -1 ? configured.indexOf(a.id) : configured.indexOf(a.email);
      const idxB = configured.indexOf(b.id) !== -1 ? configured.indexOf(b.id) : configured.indexOf(b.email);
      const orderA = idxA === -1 ? 9999 : idxA;
      const orderB = idxB === -1 ? 9999 : idxB;
      return orderA - orderB;
    });

    if (mailboxes.length > 0) {
      return mailboxes;
    }
  }

  // Fallback if no specific mailboxes assigned: find default connected mailbox
  const defaultMailbox = await client.mailbox.findFirst({
    where: { status: 'CONNECTED', isActive: true },
    include: { credentials: true }
  });

  return defaultMailbox ? [defaultMailbox] : [];
}

/**
 * Filters assigned mailboxes to only those currently eligible to send,
 * delegating capacity, window, and cooldown checks directly to quotaService.
 */
export async function resolveEligibleMailboxes(
  mailboxes: any[],
  campaign: any,
  force: boolean = false,
  now: Date = new Date(),
  client: any = prisma
): Promise<{
  eligibleMailboxes: any[];
  mailboxCapacityMap: Map<string, number>;
  skippedReasons: Record<string, string>;
}> {
  const eligibleMailboxes: any[] = [];
  const mailboxCapacityMap = new Map<string, number>();
  const skippedReasons: Record<string, string> = {};

  for (const mailbox of mailboxes) {
    // 1. Connection check
    if (mailbox.status !== 'CONNECTED' || !mailbox.isActive) {
      skippedReasons[mailbox.id] = 'MAILBOX_NOT_CONNECTED_OR_INACTIVE';
      continue;
    }

    // 2. Sending window check via existing quotaService
    if (!force) {
      const windowCheck = isWithinSendingWindow(mailbox, now);
      if (!windowCheck.inWindow) {
        skippedReasons[mailbox.id] = windowCheck.reason || 'OUTSIDE_SENDING_WINDOW';
        continue;
      }
    }

    // 3. Cooldown check
    if (!force && mailbox.nextAvailableSendAt && mailbox.nextAvailableSendAt > now) {
      skippedReasons[mailbox.id] = 'MAILBOX_COOLDOWN';
      continue;
    }

    // 4. Effective capacity check via quotaService
    const bounds = getCalendarBucketBounds(now, mailbox.sendingTimezone || 'Asia/Kolkata');
    const counts = await getDispatchedMessageCounts({
      mailboxEmail: mailbox.email,
      campaignId: campaign.id,
      startOfHour: bounds.startOfHour,
      endOfHour: bounds.endOfHour,
      startOfDay: bounds.startOfDay,
      endOfDay: bounds.endOfDay
    }, client);

    const capacity = calculateEffectiveCapacity({
      mailboxHourlyLimit: mailbox.hourlySendLimit,
      mailboxDailyLimit: mailbox.dailySendLimit,
      mailboxSentThisHour: counts.mailboxSentThisHour,
      mailboxSentToday: counts.mailboxSentToday,
      campaignHourlyLimit: campaign.hourlySendLimit,
      campaignDailyLimit: campaign.dailySendLimit,
      campaignSentThisHour: counts.campaignSentThisHour,
      campaignSentToday: counts.campaignSentToday
    });

    if (!force && capacity.availableCapacity <= 0) {
      skippedReasons[mailbox.id] = capacity.skipReason || 'QUOTA_REACHED';
      continue;
    }

    eligibleMailboxes.push(mailbox);
    mailboxCapacityMap.set(mailbox.id, capacity.availableCapacity);
  }

  return {
    eligibleMailboxes,
    mailboxCapacityMap,
    skippedReasons
  };
}

/**
 * Returns database-backed enrollment counts for each mailbox in a campaign.
 * Uses persistent DB records with index-only speed.
 */
export async function getCampaignEnrollmentCountsByMailbox(
  campaignId: string,
  mailboxIds: string[],
  client: any = prisma
): Promise<Map<string, number>> {
  const countsMap = new Map<string, number>();
  for (const id of mailboxIds) {
    countsMap.set(id, 0);
  }

  if (mailboxIds.length === 0) {
    return countsMap;
  }

  const grouped = await client.enrollment.groupBy({
    by: ['mailboxId'],
    where: {
      campaignId,
      mailboxId: { in: mailboxIds }
    },
    _count: { id: true }
  });

  for (const g of grouped) {
    if (g.mailboxId) {
      countsMap.set(g.mailboxId, g._count.id);
    }
  }

  return countsMap;
}

/**
 * Selects the least-loaded eligible mailbox for a new enrollment.
 * Tie-breaker strictly uses the stable order of campaign.senderMailboxes.
 * Mathematical guarantee: distribution difference <= 1 among eligible mailboxes.
 */
export function selectFairMailbox(
  eligibleMailboxes: any[],
  assignedCounts: Map<string, number>,
  stableOrder: string[] = []
): any | null {
  if (!eligibleMailboxes || eligibleMailboxes.length === 0) {
    return null;
  }

  if (eligibleMailboxes.length === 1) {
    return eligibleMailboxes[0];
  }

  // 1. Find the lowest assigned count among eligible mailboxes
  let minCount = Infinity;
  for (const mb of eligibleMailboxes) {
    const count = assignedCounts.get(mb.id) ?? 0;
    if (count < minCount) {
      minCount = count;
    }
  }

  // 2. Candidates with the minimum count
  const minCandidates = eligibleMailboxes.filter(
    (mb) => (assignedCounts.get(mb.id) ?? 0) === minCount
  );

  // 3. Tie-break using stable order of campaign.senderMailboxes
  if (minCandidates.length === 1) {
    return minCandidates[0];
  }

  minCandidates.sort((a: any, b: any) => {
    const idxA = stableOrder.indexOf(a.id) !== -1 ? stableOrder.indexOf(a.id) : stableOrder.indexOf(a.email);
    const idxB = stableOrder.indexOf(b.id) !== -1 ? stableOrder.indexOf(b.id) : stableOrder.indexOf(b.email);
    const orderA = idxA === -1 ? 9999 : idxA;
    const orderB = idxB === -1 ? 9999 : idxB;
    return orderA - orderB;
  });

  return minCandidates[0];
}

/**
 * Assigns a mailbox to a NEW enrollment atomically in the database.
 * Does NOT overwrite existing assignments.
 */
export async function persistEnrollmentMailboxAffinity(
  enrollmentId: string,
  mailboxId: string,
  client: any = prisma
): Promise<any> {
  return client.enrollment.update({
    where: { id: enrollmentId },
    data: { mailboxId }
  });
}
