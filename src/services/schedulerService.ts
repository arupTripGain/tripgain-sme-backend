import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import Handlebars from 'handlebars';
import { decrypt } from '../controllers/mailboxController';
import {
  getCalendarBucketBounds,
  isWithinSendingWindow,
  getDispatchedMessageCounts,
  calculateEffectiveCapacity,
  hashStringTo32BitInt,
  tryAcquireMailboxLock,
  releaseMailboxLock
} from './quotaService';
import {
  getCampaignAssignedMailboxes,
  resolveEligibleMailboxes,
  getCampaignEnrollmentCountsByMailbox,
  selectFairMailbox
} from './rotationService';
import {
  calculateNextEligibleSendTime,
  resolveEffectiveSendingDays
} from '../utils/businessDays';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Stale-pending threshold: a PENDING EmailMessage older than this is recovered
// ---------------------------------------------------------------------------
const STALE_PENDING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// TickSummary — structured counters for every scheduler run
// ---------------------------------------------------------------------------
interface TickSummary {
  campaignsChecked: number;
  mailboxesEligible: number;
  candidatesExamined: number;
  emailsSent: number;
  emailsSkipped: number;
  duplicateSentReconciled: number;
  duplicateFailedHandled: number;
  stalePendingRecovered: number;
  safetySkipped: number;
  suppressed: number;
  cooldownBlocked: number;
  capacityBlocked: number;
  failed: number;
  holBlockedAvoided: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Capacity Pacing Calculation Utilities
// ---------------------------------------------------------------------------

/**
 * Calculates minutes remaining in current calendar hour in mailbox's timezone
 */
export function getMinutesRemainingInHour(now: Date = new Date(), timeZone: string = 'Asia/Kolkata'): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const minPart = parts.find(p => p.type === 'minute');
  const minute = minPart ? parseInt(minPart.value, 10) : now.getMinutes();
  return Math.max(1, 60 - minute);
}

/**
 * Calculates minutes remaining in mailbox's daily sending window
 */
export function getMinutesRemainingInWindow(
  mailbox: { sendingTimezone?: string | null; sendingEndTime?: string | null },
  now: Date = new Date()
): number {
  const timeZone = mailbox.sendingTimezone || 'Asia/Kolkata';
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') partMap[p.type] = p.value;
  }
  const currentMinutes = parseInt(partMap.hour || '0', 10) * 60 + parseInt(partMap.minute || '0', 10);
  const endStr = (mailbox.sendingEndTime || '19:30:00').trim();
  const [endH, endM] = endStr.split(':').map(Number);
  const endMinutes = (endH || 0) * 60 + (endM || 0);
  return Math.max(0, endMinutes - currentMinutes);
}

/**
 * Calculates safe target batch size for this scheduler tick.
 * Evaluates remaining hourly/daily capacity against remaining window time,
 * scaling dynamically so capacity is actually consumed without bursting.
 */
export function calculateTargetBatchSize(params: {
  availableCapacity: number;
  hourlySendLimit: number;
  minutesRemainingInHour: number;
  minutesRemainingInWindow: number;
  isForce?: boolean;
}): number {
  const {
    availableCapacity,
    hourlySendLimit,
    minutesRemainingInHour,
    minutesRemainingInWindow,
    isForce = false
  } = params;

  if (isForce) return Math.min(50, availableCapacity);
  if (availableCapacity <= 0) return 0;

  // Window remaining time is the tighter of the hour remaining or sending-window end
  const effectiveMinutes = Math.max(1, Math.min(minutesRemainingInHour, minutesRemainingInWindow));

  // Rate needed per minute to utilize remaining capacity across remaining time
  const neededPerMinute = availableCapacity / effectiveMinutes;

  // Safe upper ceiling per tick to prevent burst (e.g. max 3/tick for 30/hr, max 6/tick for 60/hr)
  const maxSafePerTick = Math.max(1, Math.min(10, Math.ceil(hourlySendLimit / 10)));

  return Math.min(
    availableCapacity,
    Math.max(1, Math.min(maxSafePerTick, Math.ceil(neededPerMinute)))
  );
}

/**
 * Capacity-aware cooldown calculation.
 * Sets nextAvailableSendAt such that after sending batchSize emails,
 * the remaining quota drips smoothly across the remainder of the hour.
 */
export function calculatePacedDelaySeconds(
  hourlyLimit: number = 20,
  batchSizeSent: number = 1,
  remainingAfterBatch: number = 0,
  minutesRemainingInWindow: number = 60,
  isForce: boolean = false
): number {
  if (isForce) return 5;
  const safeLimit = Math.max(1, hourlyLimit || 20);

  let baseIntervalSeconds: number;
  if (remainingAfterBatch > 0) {
    // Pace remaining emails evenly across remaining seconds in the hour/window
    const remainingSeconds = Math.max(15, minutesRemainingInWindow * 60);
    const intervalPerEmail = Math.floor(remainingSeconds / (remainingAfterBatch + batchSizeSent));
    baseIntervalSeconds = Math.max(15, intervalPerEmail);
  } else {
    // Quota exhausted for the hour/window, cooldown for remainder of hour
    baseIntervalSeconds = Math.max(60, minutesRemainingInWindow * 60);
  }

  // Safe human jitter (±10%, capped between 2 and 15 seconds)
  const maxJitter = Math.min(15, Math.max(2, Math.floor(baseIntervalSeconds * 0.1)));
  const jitter = Math.floor(Math.random() * (maxJitter * 2 + 1)) - maxJitter;
  return Math.max(15, baseIntervalSeconds + jitter);
}

// ---------------------------------------------------------------------
// Safety Checks
// ---------------------------------------------------------------------
async function shouldStopBeforeSend(enrollmentId: string): Promise<{ stop: boolean; reason?: string }> {
  const enrollment = await prisma.enrollment.findUnique({
    where: { id: enrollmentId },
    include: { campaign: true, contact: { include: { emails: true } } }
  });
  
  if (!enrollment) return { stop: true, reason: "NOT_FOUND" };
  const { campaign, contact } = enrollment;

  if (campaign.status !== "active") return { stop: true, reason: "CAMPAIGN_NOT_ACTIVE" };
  if (contact.doNotContact) return { stop: true, reason: "DO_NOT_CONTACT" };
  if (enrollment.status === "replied") return { stop: true, reason: "REPLY_RECEIVED" };
  if (enrollment.status === "unsubscribed") return { stop: true, reason: "UNSUBSCRIBED" };
  if (enrollment.status === "bounced") return { stop: true, reason: "HARD_BOUNCE" };
  if (enrollment.status === "completed") return { stop: true, reason: "COMPLETED" };
  
  // Checking suppression list
  const primaryEmail = contact.emails.find(e => e.isPrimary)?.normalizedEmail || contact.emails[0]?.normalizedEmail;
  if (primaryEmail) {
    const suppressed = await prisma.suppressionList.findUnique({
      where: { normalizedEmail: primaryEmail }
    });
    if (suppressed) return { stop: true, reason: "SUPPRESSED" };
  }

  return { stop: false };
}

// ---------------------------------------------------------------------
// Duplicate Reconciliation
// Prevents HOL-blocking by handling existing EmailMessages safely rather
// than simply skipping and leaving the enrollment stuck in the queue.
// ---------------------------------------------------------------------
async function reconcileExistingEmailMessage(
  duplicate: { id: string; status: string; createdAt: Date; sentAt?: Date | null },
  enrollment: {
    id: string;
    sequenceId: string;
    currentStep: number;
    status: string;
    campaignId: string;
  },
  campaign: { id: string; name: string; campaignType?: string | null; timezone?: string | null; sendingDays?: any; sendingWindowStart?: string | null; sendingWindowEnd?: string | null },
  mailbox: { id: string; sendingTimezone?: string | null; sendingDays?: any; sendingStartTime?: string | null; sendingEndTime?: string | null; hourlySendLimit?: number | null },
  step: { id: string; stepNumber: number; delayDays?: any },
  options: { force?: boolean | undefined },
  ts: TickSummary
): Promise<'ADVANCE_ENROLLMENT' | 'SKIP_INFLIGHT' | 'MARK_FAILED'> {
  const SENT_STATUSES = new Set(['sent', 'delivered', 'opened', 'clicked', 'replied']);
  const status = duplicate.status;
  const ageMs = Date.now() - duplicate.createdAt.getTime();
  const ageMinutes = Math.round(ageMs / 60000);

  // ── CASE A: Message was successfully sent ──────────────────────────────
  if (SENT_STATUSES.has(status)) {
    console.log(
      `[DUPLICATE_RECONCILE] campaignId=${campaign.id} enrollmentId=${enrollment.id} ` +
      `stepId=${step.id} existingStatus=${status} action=ADVANCE_ENROLLMENT`
    );
    try {
      const nextStep = await prisma.sequenceStep.findFirst({
        where: { sequenceId: enrollment.sequenceId, stepNumber: step.stepNumber + 1 }
      });

      let nextSendAt: Date | null = null;
      if (nextStep && !options.force) {
        const timezone = mailbox?.sendingTimezone || campaign.timezone || 'Asia/Kolkata';
        const effectiveSendingDays = resolveEffectiveSendingDays({
          campaignDays: campaign.sendingDays,
          mailboxDays: mailbox?.sendingDays
        });
        nextSendAt = calculateNextEligibleSendTime({
          from: new Date(),
          delayDays: Number(nextStep.delayDays ?? 0),
          sendingDays: effectiveSendingDays,
          sendingWindowStart: mailbox?.sendingStartTime || campaign.sendingWindowStart || '09:30',
          sendingWindowEnd: mailbox?.sendingEndTime || campaign.sendingWindowEnd || '17:30',
          timezone
        });
      } else if (nextStep && options.force) {
        nextSendAt = new Date(Date.now() + 5000);
      }

      const isBulk = campaign.campaignType === 'BULK_EMAIL';
      const newStatus = nextStep ? 'active' : (isBulk ? 'sent' : 'completed');

      await prisma.enrollment.update({
        where: { id: enrollment.id },
        data: {
          currentStep: nextStep ? nextStep.stepNumber : step.stepNumber,
          status: newStatus,
          lastSentAt: duplicate.sentAt ?? new Date(),
          nextSendAt,
          lockedAt: null,
          lockedBy: null,
          lockExpiresAt: null
        }
      });

      ts.duplicateSentReconciled++;
      ts.holBlockedAvoided++;
    } catch (err) {
      console.error(`[DUPLICATE_RECONCILE] ADVANCE_ENROLLMENT failed for enrollment ${enrollment.id}:`, err);
    }
    return 'ADVANCE_ENROLLMENT';
  }

  // ── CASE C: Message is still PENDING ──────────────────────────────────
  if (status === 'pending') {
    if (ageMs < STALE_PENDING_THRESHOLD_MS) {
      // Potentially in-flight — do NOT touch the message, do NOT block the queue
      console.log(
        `[DUPLICATE_RECONCILE] enrollmentId=${enrollment.id} existingStatus=pending ` +
        `ageMinutes=${ageMinutes} action=SKIP_INFLIGHT (in-flight, leave untouched)`
      );
      // Release our lock so the enrollment isn't stuck
      await prisma.enrollment.updateMany({
        where: { id: enrollment.id },
        data: { lockedAt: null, lockedBy: null, lockExpiresAt: null }
      });
      ts.stalePendingRecovered++;
      ts.holBlockedAvoided++;
      return 'SKIP_INFLIGHT';
    }

    // Stale pending — recover it
    console.log(
      `[DUPLICATE_RECONCILE] enrollmentId=${enrollment.id} existingStatus=pending ` +
      `ageMinutes=${ageMinutes} action=RECOVER_STALE_PENDING`
    );
    try {
      await prisma.emailMessage.update({
        where: { id: duplicate.id },
        data: {
          status: 'failed',
          failedAt: new Date(),
          failureReason: 'STALE_PENDING_RECOVERED',
          transportStatus: 'FAILED'
        }
      });
    } catch (err) {
      console.error(`[DUPLICATE_RECONCILE] Could not recover stale pending message ${duplicate.id}:`, err);
    }
    ts.stalePendingRecovered++;
    ts.holBlockedAvoided++;
    // Fall through to MARK_FAILED to bump nextSendAt and unblock
  }

  // ── CASE B: Message is FAILED (or just recovered from stale PENDING) ──
  console.log(
    `[DUPLICATE_RECONCILE] enrollmentId=${enrollment.id} existingStatus=${status} ` +
    `action=MARK_FAILED (bumping nextSendAt by 24h to unblock queue)`
  );
  try {
    const isBulk = campaign.campaignType === 'BULK_EMAIL';
    await prisma.enrollment.update({
      where: { id: enrollment.id },
      data: {
        ...(isBulk ? { status: 'failed' } : {}),
        failureCount: { increment: 1 },
        lastError: 'DUPLICATE_FAILED',
        // Bump nextSendAt by 24h so this enrollment doesn't immediately re-appear
        nextSendAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        lockedAt: null,
        lockedBy: null,
        lockExpiresAt: null
      }
    });
  } catch (err) {
    console.error(`[DUPLICATE_RECONCILE] MARK_FAILED update failed for enrollment ${enrollment.id}:`, err);
  }
  ts.duplicateFailedHandled++;
  ts.holBlockedAvoided++;
  return 'MARK_FAILED';
}

// ---------------------------------------------------------------------
// Two-Tier Hierarchical Capacity & Window Check
// ---------------------------------------------------------------------
async function getEffectiveCapacity(
  mailbox: any,
  campaign: any,
  force = false,
  precomputedCapacity?: number,
  client: any = prisma
) {
  if (force) {
    return {
      availableCapacity: 50,
      skipReason: null,
      mailboxRemainingHourly: 50,
      mailboxRemainingDaily: 50,
      campaignRemainingHourly: 50,
      campaignRemainingDaily: 50
    };
  }

  // 1. Enforce sending window (sendingDays, sendingStartTime, sendingEndTime in sendingTimezone)
  const windowCheck = isWithinSendingWindow(mailbox);
  if (!windowCheck.inWindow) {
    return {
      availableCapacity: 0,
      skipReason: windowCheck.reason || 'OUTSIDE_SENDING_WINDOW',
      mailboxRemainingHourly: 0,
      mailboxRemainingDaily: 0,
      campaignRemainingHourly: 0,
      campaignRemainingDaily: 0
    };
  }

  // If capacity was already precomputed in the same tick under window & quota evaluation, reuse it directly
  if (precomputedCapacity !== undefined) {
    return {
      availableCapacity: Math.max(0, precomputedCapacity),
      skipReason: precomputedCapacity <= 0 ? 'QUOTA_REACHED' : null,
      mailboxRemainingHourly: precomputedCapacity,
      mailboxRemainingDaily: precomputedCapacity,
      campaignRemainingHourly: precomputedCapacity,
      campaignRemainingDaily: precomputedCapacity
    };
  }

  // 2. Derive exact calendar-hour and calendar-day bounds based on mailbox.sendingTimezone
  const bounds = getCalendarBucketBounds(new Date(), mailbox.sendingTimezone || 'Asia/Kolkata');

  // 3. Ground-truth query of successfully dispatched outbound messages (single round-trip)
  const counts = await getDispatchedMessageCounts({
    mailboxEmail: mailbox.email,
    campaignId: campaign.id,
    startOfHour: bounds.startOfHour,
    endOfHour: bounds.endOfHour,
    startOfDay: bounds.startOfDay,
    endOfDay: bounds.endOfDay
  }, client);

  // 4. Calculate effective capacity respecting both mailbox and campaign ceilings
  return calculateEffectiveCapacity({
    mailboxHourlyLimit: mailbox.hourlySendLimit,
    mailboxDailyLimit: mailbox.dailySendLimit,
    mailboxSentThisHour: counts.mailboxSentThisHour,
    mailboxSentToday: counts.mailboxSentToday,
    campaignHourlyLimit: campaign.hourlySendLimit,
    campaignDailyLimit: campaign.dailySendLimit,
    campaignSentThisHour: counts.campaignSentThisHour,
    campaignSentToday: counts.campaignSentToday
  });
}

// ---------------------------------------------------------------------------
// Mailbox Dispatch Plan Interface (Phase 1 -> Phase 2)
// ---------------------------------------------------------------------------
export interface MailboxDispatchPlan {
  mailbox: any;
  campaign: any;
  dueEnrollments: any[];
  resolvedBatchTarget: number;
  precomputedCap?: number | undefined;
}

// ---------------------------------------------------------------------
// Main Scheduler Loop
// ---------------------------------------------------------------------
export async function processEmailScheduler(options: { 
  force?: boolean | undefined; 
  bypassStepDelay?: boolean | undefined;
  campaignId?: string | undefined;
} = {}): Promise<{ 
  emailsSent: number; 
  emailsSkipped: number; 
  emailsFailed: number;
}> {
  const workerId = crypto.randomUUID();
  let emailsSent = 0;
  let emailsSkipped = 0;
  let emailsFailed = 0;

  // Structured tick counters — accumulated throughout this run
  const ts: TickSummary = {
    campaignsChecked: 0,
    mailboxesEligible: 0,
    candidatesExamined: 0,
    emailsSent: 0,
    emailsSkipped: 0,
    duplicateSentReconciled: 0,
    duplicateFailedHandled: 0,
    stalePendingRecovered: 0,
    safetySkipped: 0,
    suppressed: 0,
    cooldownBlocked: 0,
    capacityBlocked: 0,
    failed: 0,
    holBlockedAvoided: 0,
    durationMs: 0
  };

  const isBypassingDelay = Boolean(options.force || options.bypassStepDelay);
  const now = new Date();
  const tickStart = performance.now();
  console.log(`[Scheduler] Starting run. Worker ID: ${workerId}, Force: ${!!options.force}, BypassDelay: ${isBypassingDelay}${options.campaignId ? `, Campaign: ${options.campaignId}` : ''}`);
  
  const run = await prisma.schedulerRun.create({
    data: { workerId }
  });

  try {
    const enrollmentDueCondition: any = {
      status: { in: ['pending', 'active'] },
      AND: [
        {
          OR: [
            { lockedAt: null },
            { lockExpiresAt: { lte: now } }
          ]
        }
      ]
    };

    if (!isBypassingDelay) {
      enrollmentDueCondition.AND.push({
        OR: [
          { nextSendAt: { lte: now } },
          { nextSendAt: null }
        ]
      });
    }

    const campaignWhere: any = {
      status: 'active',
      enrollments: {
        some: enrollmentDueCondition
      }
    };

    if (options.campaignId) {
      campaignWhere.id = options.campaignId;
      if (!options.force) {
        campaignWhere.approvalStatus = 'APPROVED';
      }
    } else {
      campaignWhere.approvalStatus = 'APPROVED';
    }

    const tCampSelect = performance.now();
    const campaigns = await prisma.campaign.findMany({
      where: campaignWhere
    });
    const campSelectDuration = Math.round(performance.now() - tCampSelect);
    console.log(`[Scheduler] Campaign selection: ${campSelectDuration}ms (${campaigns.length} campaigns with due leads)`);

    // =========================================================================
    // PHASE 1: SEQUENTIAL ATOMIC RESERVATION
    // - Runs sequentially in PostgreSQL transactions (~15-25ms total)
    // - Evaluates campaign quota with atomic reservation decrement
    // - Selects due candidates (Follow-ups with affinity + New leads via rotation)
    // - Applies database row locks (lockedBy: workerId, lockExpiresAt: 10m)
    // - Enforces 1 plan per distinct mailbox (cooldown/multi-campaign isolation)
    // =========================================================================
    const dispatchPlans: MailboxDispatchPlan[] = [];
    const reservedMailboxIds = new Set<string>();

    for (const campaign of campaigns) {
      const campStart = performance.now();

      // 0. Campaign approval check
      if (campaign.approvalStatus && campaign.approvalStatus !== 'APPROVED') {
        console.log(`[Scheduler] Skip reason: campaign "${campaign.name}" not approved (approvalStatus: ${campaign.approvalStatus})`);
        continue;
      }

      // 1. Resolve all active, connected mailboxes assigned to this campaign in stable order
      const tMbResolve = performance.now();
      const assignedMailboxes = await getCampaignAssignedMailboxes(campaign, prisma);
      if (assignedMailboxes.length === 0) {
        console.log(`[Scheduler] Skip reason: no eligible mailbox for campaign "${campaign.name}" (${campaign.id}) (NO_MAILBOX_AVAILABLE)`);
        continue;
      }

      // 2. Protect orphaned in-progress enrollments (e.g. if assigned mailbox was deleted after sending started)
      const orphanedCount = await prisma.enrollment.count({
        where: {
          campaignId: campaign.id,
          mailboxId: null,
          lastSentAt: { not: null },
          status: { in: ['pending', 'active'] }
        }
      });
      if (orphanedCount > 0) {
        console.warn(`[Scheduler] Campaign "${campaign.name}" has ${orphanedCount} in-progress enrollments with mailboxId = NULL (ASSIGNED_MAILBOX_DELETED). Holding them to preserve sender identity and email threading.`);
      }

      // 3. Resolve eligible mailboxes for this campaign using quotaService
      const { eligibleMailboxes, mailboxCapacityMap, skippedReasons } = await resolveEligibleMailboxes(
        assignedMailboxes,
        campaign,
        !!options.force,
        now,
        prisma
      );

      const mbResolveDuration = Math.round(performance.now() - tMbResolve);
      console.log(`[Scheduler] Campaign "${campaign.name}": resolved ${eligibleMailboxes.length}/${assignedMailboxes.length} eligible mailboxes in ${mbResolveDuration}ms`);

      if (eligibleMailboxes.length === 0) {
        console.log(`[Scheduler] Skip reason: no eligible mailboxes for campaign "${campaign.name}" (${JSON.stringify(skippedReasons)})`);
        continue;
      }

      // Campaign Quota Budget:
      // Derive initial available capacity for this campaign in current hour/day
      // and maintain a decrementing reservation budget across mailboxes in this campaign
      let campaignBudget = 999999;
      if (!options.force) {
        const bounds = getCalendarBucketBounds(now, campaign.timezone || 'Asia/Kolkata');
        const validStatuses = ['sent', 'delivered', 'opened', 'clicked', 'bounced'];
        const [campHour, campDay] = await Promise.all([
          prisma.emailMessage.count({
            where: {
              campaignId: campaign.id,
              status: { in: validStatuses },
              sentAt: { gte: bounds.startOfHour, lt: bounds.endOfHour }
            }
          }),
          prisma.emailMessage.count({
            where: {
              campaignId: campaign.id,
              status: { in: validStatuses },
              sentAt: { gte: bounds.startOfDay, lt: bounds.endOfDay }
            }
          })
        ]);
        const remHourly = Math.max(0, (campaign.hourlySendLimit ?? 999999) - campHour);
        const remDaily = Math.max(0, (campaign.dailySendLimit ?? 999999) - campDay);
        campaignBudget = Math.min(remHourly, remDaily);
      }

      // 4. Reserve candidates sequentially per eligible mailbox
      for (const mailbox of eligibleMailboxes) {
        // Enforce 1 active plan per mailbox in this tick
        if (reservedMailboxIds.has(mailbox.id)) {
          console.log(`[Scheduler] Mailbox ${mailbox.email} already reserved in an earlier campaign this tick. Skipping.`);
          continue;
        }

        if (campaignBudget <= 0) {
          console.log(`[Scheduler] Campaign "${campaign.name}" reservation budget exhausted for this tick.`);
          ts.capacityBlocked++;
          break;
        }

        const lockKey = hashStringTo32BitInt(`mb_tx_lock:${mailbox.id}`);
        let dueEnrollments: any[] = [];
        const precomputedCap = mailboxCapacityMap.get(mailbox.id);

        let reservation: any;
        try {
          reservation = await prisma.$transaction(async (tx) => {
            // A. Transaction-level advisory lock on mailbox
            const lockResult = await tx.$queryRaw<Array<{ locked: boolean }>>`
              SELECT pg_try_advisory_xact_lock(${lockKey}) as locked
            `;

            if (!lockResult[0]?.locked) {
              return { dueEnrollments: [], skipReason: 'MAILBOX_LOCKED' };
            }

            // B. Re-evaluate capacity within transaction using precomputed capacity
            const capacity = await getEffectiveCapacity(mailbox, campaign, !!options.force, precomputedCap, tx);
            const effectiveCapacity = Math.min(capacity.availableCapacity, campaignBudget);
            if (effectiveCapacity <= 0) {
              return { dueEnrollments: [], skipReason: capacity.skipReason || 'QUOTA_REACHED' };
            }

            // C. Ensure mailbox isn't in cooldown
            if (!options.force && mailbox.nextAvailableSendAt && mailbox.nextAvailableSendAt > now) {
              return { dueEnrollments: [], skipReason: 'MAILBOX_COOLDOWN' };
            }

            // Calculate capacity-aware paced batch limit for this run tick
            const mbTz = mailbox.sendingTimezone || 'Asia/Kolkata';
            const minutesRemainingInHour = getMinutesRemainingInHour(now, mbTz);
            const minutesRemainingInWindow = getMinutesRemainingInWindow(mailbox, now);

            const targetBatchSize = calculateTargetBatchSize({
              availableCapacity: effectiveCapacity,
              hourlySendLimit: mailbox.hourlySendLimit || 20,
              minutesRemainingInHour,
              minutesRemainingInWindow,
              isForce: !!options.force
            });

            const toSend: any[] = [];

            // D. Priority 1: Follow-up enrollments strictly assigned to THIS mailbox (Affinity)
            const followUpWhere: any = {
              campaignId: campaign.id,
              mailboxId: mailbox.id,
              status: { in: ['pending', 'active'] },
              AND: [
                {
                  OR: [
                    { lockedAt: null },
                    { lockExpiresAt: { lte: new Date() } }
                  ]
                }
              ]
            };

            if (!isBypassingDelay) {
              followUpWhere.AND.push({
                OR: [
                  { nextSendAt: { lte: new Date() } },
                  { nextSendAt: null }
                ]
              });
            }

            const candidateBufferSize = Math.min(50, targetBatchSize * 10 + targetBatchSize);

            const followUps = await tx.enrollment.findMany({
              where: followUpWhere,
              take: candidateBufferSize,
              orderBy: { nextSendAt: 'asc' }
            });

            toSend.push(...followUps);

            // E. Priority 2: If capacity remains, select NEW unassigned leads via fair least-loaded rotation
            const remainingCapacity = targetBatchSize - toSend.length;
            if (remainingCapacity > 0) {
              const newLeadWhere: any = {
                campaignId: campaign.id,
                mailboxId: null,
                lastSentAt: null,
                status: { in: ['pending', 'active'] },
                AND: [
                  {
                    OR: [
                      { lockedAt: null },
                      { lockExpiresAt: { lte: new Date() } }
                    ]
                  }
                ]
              };

              if (!isBypassingDelay) {
                newLeadWhere.AND.push({
                  OR: [
                    { nextSendAt: { lte: new Date() } },
                    { nextSendAt: null }
                  ]
                });
              }

              // Query persistent database assignment counts
              const countsMap = await getCampaignEnrollmentCountsByMailbox(
                campaign.id,
                assignedMailboxes.map((m: any) => m.id),
                tx
              );

              // Pull candidates for rotation evaluation — buffered to prevent HOL blocking
              const newCandidates = await tx.enrollment.findMany({
                where: newLeadWhere,
                take: Math.max(remainingCapacity * 10, 10),
                orderBy: { createdAt: 'asc' }
              });

              for (const candidate of newCandidates) {
                if (toSend.length >= targetBatchSize) break;

                const chosen = selectFairMailbox(eligibleMailboxes, countsMap, campaign.senderMailboxes);
                if (chosen && chosen.id === mailbox.id) {
                  // Atomically assign mailboxId to this new enrollment in the DB
                  await tx.enrollment.update({
                    where: { id: candidate.id },
                    data: { mailboxId: mailbox.id }
                  });
                  // Update local count so subsequent leads in this tick rotate fairly
                  countsMap.set(mailbox.id, (countsMap.get(mailbox.id) || 0) + 1);
                  toSend.push(candidate);
                }
              }
            }

            if (toSend.length === 0) {
              return { dueEnrollments: [] };
            }

            // F. Lock candidate enrollments for this worker
            const candidateIds = toSend.map((c) => c.id);
            await tx.enrollment.updateMany({
              where: { id: { in: candidateIds } },
              data: {
                lockedAt: new Date(),
                lockedBy: workerId,
                lockExpiresAt: new Date(Date.now() + 10 * 60 * 1000)
              }
            });

            return { dueEnrollments: toSend, targetBatchSize };
          });

          if (reservation.skipReason) {
            if (reservation.skipReason === 'MAILBOX_COOLDOWN') ts.cooldownBlocked++;
            else if (reservation.skipReason === 'QUOTA_REACHED') ts.capacityBlocked++;
            console.log(`[Scheduler] Skip reason: ${reservation.skipReason} for campaign "${campaign.name}" via mailbox ${mailbox.email}.`);
            continue;
          }

          dueEnrollments = reservation.dueEnrollments;
          if (dueEnrollments && dueEnrollments.length > 0) {
            ts.mailboxesEligible++;
            const resolvedBatchTarget: number = (reservation?.targetBatchSize as number) ?? 1;
            // Decrement campaign budget by the actual number of candidates we intend to send
            campaignBudget -= Math.min(dueEnrollments.length, resolvedBatchTarget);
            reservedMailboxIds.add(mailbox.id);
            dispatchPlans.push({
              mailbox,
              campaign,
              dueEnrollments,
              resolvedBatchTarget,
              precomputedCap
            });
          }
        } catch (txErr) {
          console.error(`[Scheduler] Reservation transaction error for mailbox ${mailbox.email}:`, txErr);
          continue;
        }
      }
    }

    // =========================================================================
    // PHASE 2: CONCURRENT MAILBOX DISPATCH
    // - Runs up to 7 mailbox workers in parallel using Promise.allSettled
    // - Each mailbox worker executes its own reserved candidates sequentially
    // - Intra-mailbox ordering, 3-second pacing, and cooldown updates preserved
    // - Separate SMTP transports and TLS connections isolated per mailbox
    // - Errors in one mailbox worker do not cancel or affect other mailbox workers
    // =========================================================================
    console.log(`[Scheduler] Phase 1 reservation complete: ${dispatchPlans.length} mailbox dispatch plans created. Starting Phase 2 concurrent dispatch...`);

    const mailboxResults = await Promise.allSettled(
      dispatchPlans.map((plan) =>
        executeMailboxDispatch(plan, workerId, options, now, ts)
      )
    );

    for (const res of mailboxResults) {
      if (res.status === 'fulfilled') {
        emailsSent += res.value.sent;
        emailsSkipped += res.value.skipped;
        emailsFailed += res.value.failed;
      } else {
        console.error('[Scheduler] Mailbox dispatch worker failed unexpectedly:', res.reason);
        emailsFailed++;
        ts.failed++;
      }
    }

    // Check completion for bulk campaigns that were processed
    const bulkCampaigns = Array.from(new Set(dispatchPlans.filter(p => p.campaign.campaignType === 'BULK_EMAIL').map(p => p.campaign)));
    for (const camp of bulkCampaigns) {
      const remainingPending = await prisma.enrollment.count({
        where: {
          campaignId: camp.id,
          status: { in: ['pending', 'sending', 'active'] }
        }
      });
      if (remainingPending === 0) {
        await prisma.campaign.update({
          where: { id: camp.id },
          data: { status: 'completed' }
        });
        console.log(`[Scheduler] Bulk campaign ${camp.id} has no remaining pending/active enrollments. Marked completed.`);
      }
    }

    // Update run record
    ts.durationMs = Math.round(performance.now() - tickStart);
    ts.campaignsChecked = campaigns.length;

    await prisma.schedulerRun.update({
      where: { id: run.id },
      data: {
        completedAt: new Date(),
        emailsSent,
        emailsSkipped,
        emailsFailed,
      }
    });

    console.log(
      `[Scheduler] Outbound tick completed in ${ts.durationMs}ms.\n` +
      `  campaignsChecked:        ${ts.campaignsChecked}\n` +
      `  mailboxesEligible:       ${ts.mailboxesEligible}\n` +
      `  candidatesExamined:      ${ts.candidatesExamined}\n` +
      `  emailsSent:              ${ts.emailsSent}\n` +
      `  emailsSkipped:           ${ts.emailsSkipped}\n` +
      `  duplicateSentReconciled: ${ts.duplicateSentReconciled}\n` +
      `  duplicateFailedHandled:  ${ts.duplicateFailedHandled}\n` +
      `  stalePendingRecovered:   ${ts.stalePendingRecovered}\n` +
      `  safetySkipped:           ${ts.safetySkipped}\n` +
      `  suppressed:              ${ts.suppressed}\n` +
      `  cooldownBlocked:         ${ts.cooldownBlocked}\n` +
      `  capacityBlocked:         ${ts.capacityBlocked}\n` +
      `  failed:                  ${ts.failed}\n` +
      `  holBlockedAvoided:       ${ts.holBlockedAvoided}`
    );

    return { emailsSent, emailsSkipped, emailsFailed };
  } catch (err) {
    console.error(`[Scheduler] Critical Error:`, err);
    return { emailsSent, emailsSkipped, emailsFailed };
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Per-Mailbox Worker Dispatch Function
// Executes an isolated MailboxDispatchPlan strictly sequentially within the mailbox,
// preserving pacing, safety checks, SMTP transport isolation, and DB locking.
// ---------------------------------------------------------------------------

async function executeMailboxDispatch(
  plan: MailboxDispatchPlan,
  workerId: string,
  options: { force?: boolean | undefined; bypassStepDelay?: boolean | undefined },
  now: Date,
  ts: TickSummary
): Promise<{ sent: number; skipped: number; failed: number }> {
  const { mailbox, campaign, dueEnrollments, resolvedBatchTarget, precomputedCap } = plan;
  let mailboxSentThisTick = 0;
  let mailboxSkipped = 0;
  let mailboxFailed = 0;

  // Acquire dedicated session-level advisory lock on this mailbox for the duration of its dispatch
  const hasLock = await tryAcquireMailboxLock(mailbox.id);
  if (!hasLock) {
    console.log(`[Scheduler] Could not acquire session lock for mailbox ${mailbox.email} in Phase 2. Skipping.`);
    // Release any candidate locks held for this worker
    const ids = dueEnrollments.map((e) => e.id);
    await prisma.enrollment.updateMany({
      where: { id: { in: ids }, lockedBy: workerId },
      data: { lockedAt: null, lockedBy: null, lockExpiresAt: null }
    });
    return { sent: 0, skipped: dueEnrollments.length, failed: 0 };
  }

  try {
    const mbTz = mailbox.sendingTimezone || 'Asia/Kolkata';
    const remHour = getMinutesRemainingInHour(now, mbTz);
    const remWindow = getMinutesRemainingInWindow(mailbox, now);
    console.log(
      `[CAPACITY] mailbox=${mailbox.email} hourly=${mailbox.hourlySendLimit || 20} ` +
      `sentToday=${mailbox.emailsSentToday || 0} sentThisHour=${mailbox.emailsSentThisHour || 0} ` +
      `availableCapacity=${precomputedCap ?? 'eval'} targetThisTick=${resolvedBatchTarget} ` +
      `minutesRemainingInHour=${remHour} minutesRemainingInWindow=${remWindow} dueCandidates=${dueEnrollments.length}`
    );

    for (const enrollment of dueEnrollments) {
      ts.candidatesExamined++;

      // Stop iterating this buffer if we've hit the target send count for this mailbox
      if (mailboxSentThisTick >= resolvedBatchTarget) break;

      let message: any = null;
      try {
        if (mailboxSentThisTick > 0 && !options.force) {
          // Intra-mailbox micro pause between multiple items in the same mailbox to prevent burst SMTP
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }

        // 1. Lock Enrollment (clearing expired locks if any, or confirming worker reservation from Phase 1)
        const locked = await prisma.enrollment.updateMany({
          where: { 
            id: enrollment.id, 
            OR: [
              { lockedAt: null },
              { lockExpiresAt: { lte: new Date() } },
              { lockedBy: workerId }
            ]
          },
          data: {
            lockedAt: new Date(),
            lockedBy: workerId,
            lockExpiresAt: new Date(Date.now() + 10 * 60 * 1000)
          }
        });

        if (locked.count === 0) {
          console.log(`[Scheduler] Enrollment ${enrollment.id} locked by another worker, skipping.`);
          continue;
        }

        // 2. Safety Checks
        const stopCheck = await shouldStopBeforeSend(enrollment.id);
        if (stopCheck.stop) {
          await prisma.enrollment.update({
            where: { id: enrollment.id },
            data: { status: stopCheck.reason === 'REPLY_RECEIVED' ? 'replied' : 'completed', stopReason: stopCheck.reason || null }
          });
          mailboxSkipped++;
          ts.emailsSkipped++;
          ts.safetySkipped++;
          continue;
        }

        // 3. Load Sequence Step
        const step = await prisma.sequenceStep.findFirst({
          where: { sequenceId: enrollment.sequenceId, stepNumber: enrollment.currentStep }
        });
        if (!step) {
          mailboxSkipped++;
          continue;
        }

        const idempotencyKey = `${campaign.id}:${enrollment.id}:${step.id}`;

        // 4. Duplicate Check + Self-Healing Reconciliation
        const duplicate = await prisma.emailMessage.findUnique({
          where: { idempotencyKey }
        });
        if (duplicate) {
          const reconcileResult = await reconcileExistingEmailMessage(
            duplicate,
            enrollment,
            campaign,
            mailbox,
            step,
            options,
            ts
          );
          mailboxSkipped++;
          ts.emailsSkipped++;
          continue;
        }

        // Re-verify campaign is still active (Kill switch / Pause check)
        const freshCamp = await prisma.campaign.findUnique({
          where: { id: campaign.id },
          select: { status: true }
        });
        if (freshCamp?.status !== 'active') {
          console.log(`[Scheduler] Campaign ${campaign.id} is ${freshCamp?.status}. Skipping dispatch.`);
          mailboxSkipped++;
          continue;
        }

        // 5. Load Contact and Render Template using Handlebars
        const contact = await prisma.contact.findUnique({ 
          where: { id: enrollment.contactId },
          include: { emails: true, organization: true }
        });

        const primaryEmail = contact?.emails?.find(e => e.isPrimary)?.email || contact?.emails?.[0]?.email || 'test@example.com';
        const normEmail = primaryEmail.trim().toLowerCase();

        // Pre-dispatch suppression & unsubscribe safety check
        const isSuppressed = await prisma.suppressionList.findFirst({
          where: { normalizedEmail: normEmail }
        });
        if (isSuppressed || contact?.doNotContact || contact?.unsubscribeAt) {
          console.log(`[Scheduler] Recipient ${primaryEmail} is suppressed or unsubscribed. Aborting dispatch.`);
          await prisma.enrollment.update({
            where: { id: enrollment.id },
            data: {
              status: 'unsubscribed',
              stoppedAt: new Date(),
              stopReason: isSuppressed ? `SUPPRESSED_${isSuppressed.reason.toUpperCase()}` : 'UNSUBSCRIBED',
              lockedAt: null,
              lockedBy: null,
              lockExpiresAt: null
            }
          });
          mailboxSkipped++;
          ts.emailsSkipped++;
          ts.suppressed++;
          continue;
        }

        // Pre-dispatch soft-bounce reputation safety check
        const hasSoftBounceState = contact?.emails?.some(e => e.verificationStatus === 'soft_bounced');
        if (hasSoftBounceState) {
          console.log(`[Scheduler] Recipient ${primaryEmail} has an active soft-bounce state. Aborting dispatch to protect sender reputation.`);
          await prisma.enrollment.update({
            where: { id: enrollment.id },
            data: {
              status: 'soft_bounced',
              stoppedAt: new Date(),
              stopReason: 'PREVIOUS_SOFT_BOUNCE',
              lockedAt: null,
              lockedBy: null,
              lockExpiresAt: null
            }
          });
          mailboxSkipped++;
          continue;
        }

        const rawBody = step.bodyTemplate || step.bodyHtmlTemplate || '';

        const isSubjectEmpty = !step.subjectTemplate || step.subjectTemplate.trim().length === 0;
        const isFollowUp = (step.stepNumber || enrollment.currentStep) > 1;

        let isReplyInThread = false;
        let parentInternetMessageId: string | null = null;
        let parentReferences: string | null = null;
        let parentProviderThreadId: string | null = null;
        let threadSubject: string = '';

        if (isFollowUp && isSubjectEmpty) {
          // Follow-up step with empty subject -> reply in thread
          const previousEmail = await prisma.emailMessage.findFirst({
            where: {
              enrollmentId: enrollment.id,
              status: { in: ['sent', 'delivered', 'opened', 'clicked', 'replied'] }
            },
            orderBy: { sentAt: 'desc' },
            include: {
              conversationMessages: {
                where: { direction: 'OUTBOUND' },
                orderBy: { sentAt: 'desc' },
                take: 1
              }
            }
          });

          if (previousEmail) {
            const prevConvMsg = previousEmail.conversationMessages?.[0];
            const prevMsgId = prevConvMsg?.internetMessageId || previousEmail.providerMessageId;

            if (prevMsgId) {
              isReplyInThread = true;
              parentInternetMessageId = prevMsgId.startsWith('<') && prevMsgId.endsWith('>') ? prevMsgId : `<${prevMsgId}>`;

              const prevMeta = (prevConvMsg?.metadata as any) || {};
              const existingReferences = typeof prevMeta.references === 'string' ? prevMeta.references.trim() : '';
              parentReferences = existingReferences 
                ? `${existingReferences} ${parentInternetMessageId}` 
                : parentInternetMessageId;

              const conv = await prisma.conversation.findFirst({
                where: {
                  OR: [
                    { enrollmentId: enrollment.id },
                    { contactId: enrollment.contactId, campaignId: campaign.id }
                  ]
                }
              });
              parentProviderThreadId = conv?.providerThreadId || (prevMeta.providerThreadId as string) || null;

              // Thread subject: MUST be the previous outbound email's exact subject, NO fallback generation
              threadSubject = previousEmail.subject || '';
            }
          }
        }

        const trackingToken = crypto.randomUUID();
        const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

        // Render Subject
        let renderedSubject = step.subjectTemplate || '';
        if (isReplyInThread) {
          const cleanThreadSubject = threadSubject.replace(/^(Re:\s*)+/i, '').trim();
          renderedSubject = `Re: ${cleanThreadSubject}`;
        } else if (renderedSubject) {
          try {
            const template = Handlebars.compile(renderedSubject);
            const contactAny = contact as any;
            renderedSubject = template({
              name: contactAny?.name || `${contact?.firstName || ''} ${contact?.lastName || ''}`.trim(),
              firstName: contact?.firstName || contactAny?.name?.split(' ')[0] || '',
              lastName: contact?.lastName || '',
              email: primaryEmail,
              company: contact?.organization?.name || '',
              ...(contactAny?.customFields || {})
            });
          } catch (err) {
            console.error('[Scheduler] Error compiling subject template:', err);
          }
        }

        // Render Body
        let renderedBody = rawBody;
        try {
          const template = Handlebars.compile(rawBody);
          const contactAny = contact as any;
          renderedBody = template({
            name: contactAny?.name || `${contact?.firstName || ''} ${contact?.lastName || ''}`.trim(),
            firstName: contact?.firstName || contactAny?.name?.split(' ')[0] || '',
            lastName: contact?.lastName || '',
            email: primaryEmail,
            company: contact?.organization?.name || '',
            ...(contactAny?.customFields || {})
          });
        } catch (err) {
          console.error('[Scheduler] Error compiling body template:', err);
        }

        // 6. Create Message Record (Pending / Dispatched)
        message = await prisma.emailMessage.create({
          data: {
            idempotencyKey,
            enrollmentId: enrollment.id,
            campaignId: campaign.id,
            sequenceStepId: step.id,
            status: 'pending',
            transportStatus: 'DISPATCHED',
            deliveryConfidence: 'UNKNOWN',
            fromEmail: mailbox.email,
            toEmail: primaryEmail,
            subject: renderedSubject,
            bodyHtml: renderedBody,
            trackingToken,
          }
        });

        // 7. REAL Sending via Nodemailer Google SMTP
        console.log(`[Scheduler] Dispatching real email to ${message.toEmail} via ${mailbox.email} (step ${step.stepNumber})`);
        let providerMessageId = `msg_${crypto.randomUUID()}`;
        let internetMessageId = `<tg_${crypto.randomUUID()}@${mailbox.email.split('@')[1] || 'tripgainapp.com'}>`;
        let rawSmtpResponse: string | null = null;
        let smtpCode: string | null = null;

        if (mailbox.credentials) {
          const smtpHost = mailbox.credentials.encryptedSmtpHost ? decrypt(mailbox.credentials.encryptedSmtpHost) : 'smtp.gmail.com';
          const smtpPort = mailbox.credentials.encryptedSmtpPort ? Number(decrypt(mailbox.credentials.encryptedSmtpPort)) : 465;
          const smtpUser = mailbox.credentials.encryptedSmtpUsername ? decrypt(mailbox.credentials.encryptedSmtpUsername) : mailbox.email;
          const smtpPass = mailbox.credentials.encryptedSmtpPassword ? decrypt(mailbox.credentials.encryptedSmtpPassword) : '';

          const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: smtpPort,
            secure: smtpPort === 465,
            auth: { user: smtpUser, pass: smtpPass },
            connectionTimeout: 10000
          });

          // Tracking base URL
          const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
          let trackingBaseUrl = (process.env.TRACKING_BASE_URL || process.env.BACKEND_URL || '').trim().replace(/\/+$/, '');
          if (isProduction) {
            if (!trackingBaseUrl || trackingBaseUrl.includes('localhost') || trackingBaseUrl.includes('127.0.0.1')) {
              console.error('[Scheduler] TRACKING_BASE_URL is missing or invalid (contains localhost) in production environment. Tracking pixel and link rewrites are omitted to fail safely without generating localhost URLs.');
              trackingBaseUrl = '';
            }
          } else if (!trackingBaseUrl) {
            trackingBaseUrl = 'http://localhost:3001';
          }

          // Open tracking pixel
          const openTrackingPixel = (campaign.openTracking !== false && trackingBaseUrl)
            ? `<img src="${trackingBaseUrl}/t/${trackingToken}" width="1" height="1" style="display:none;width:1px;height:1px;border:0;outline:none;" alt="" />`
            : '';

          // Link click tracking: rewrite external links in renderedBody and store in EmailLink database
          let finalBodyHtml = renderedBody;
          if (trackingBaseUrl) {
            try {
              const linkMatches: { originalMatch: string; originalUrl: string; restOfTag: string; linkToken: string }[] = [];
              const linkRegex = /<a\s+(?:[^>]*?\s+)?href=(["'])(https?:\/\/[^"']+)\1([^>]*)>/gi;
              let match: RegExpExecArray | null;
              while ((match = linkRegex.exec(renderedBody)) !== null) {
                const originalMatch = match[0];
                const originalUrl = match[2];
                const restOfTag = match[3] || '';
                if (originalUrl && !originalUrl.includes('/r/') && !originalUrl.includes('/t/')) {
                  const linkToken = crypto.randomUUID();
                  linkMatches.push({ originalMatch, originalUrl, restOfTag, linkToken });
                }
              }

              for (const item of linkMatches) {
                await prisma.emailLink.create({
                  data: {
                    emailMessageId: message.id,
                    trackingToken: item.linkToken,
                    destinationUrl: item.originalUrl,
                    linkType: 'BODY_LINK'
                  }
                });
                const redirectUrl = `${trackingBaseUrl}/r/${item.linkToken}`;
                finalBodyHtml = finalBodyHtml.replace(item.originalMatch, `<a href="${redirectUrl}"${item.restOfTag}>`);
              }
            } catch (rewriteErr) {
              console.error('[Scheduler] Error rewriting links for click tracking:', rewriteErr);
              finalBodyHtml = renderedBody;
            }
          }

          // Clean email HTML with proper margins for Gmail/Outlook
          const emailHtml = `
            <!DOCTYPE html>
            <html>
              <head>
                <meta charset="utf-8">
                <style>
                  body, div, p { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a1a; }
                  p { margin: 0 0 14px 0; }
                </style>
              </head>
              <body>
                ${finalBodyHtml}
                ${openTrackingPixel}
              </body>
            </html>
          `;

          // Plain text fallback
          const plainText = finalBodyHtml
            .replace(/<br\s*[\/]?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<[^>]*>?/gm, '')
            .trim();

          const mailHeaders: Record<string, string> = {
            'Message-ID': internetMessageId,
            'X-Entity-Ref-ID': message.id,
            'X-Campaign-ID': campaign.id,
            'X-Enrollment-ID': enrollment.id,
            'X-Mailer': 'TripGain Outreach Engine 1.0',
          };

          if (isReplyInThread) {
            if (parentInternetMessageId) {
              mailHeaders['In-Reply-To'] = parentInternetMessageId;
              mailHeaders['References'] = parentReferences || parentInternetMessageId;
            }
            if (parentProviderThreadId) {
              mailHeaders['X-GM-THRID'] = parentProviderThreadId;
            }
          }

          const sendResult = await transporter.sendMail({
            from: `"${mailbox.displayName || mailbox.email}" <${mailbox.email}>`,
            to: primaryEmail,
            subject: renderedSubject,
            text: plainText,
            html: emailHtml,
            headers: mailHeaders
          });

          if (sendResult.messageId) {
            providerMessageId = sendResult.messageId;
          }
          if (sendResult.response) {
            rawSmtpResponse = sendResult.response;
            const codeMatch = sendResult.response.match(/\b([245]\d\d)\b/);
            if (codeMatch && codeMatch[1]) smtpCode = codeMatch[1];
          }
        }

        // 8. Register in Unibox (Conversations & ConversationMessages)
        try {
          let conv = await prisma.conversation.findFirst({
            where: {
              OR: [
                { enrollmentId: enrollment.id },
                { contactId: enrollment.contactId, campaignId: campaign.id }
              ]
            }
          });

          const cleanText = renderedBody.replace(/<[^>]*>?/gm, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
          if (!conv) {
            conv = await prisma.conversation.create({
              data: {
                mailboxId: mailbox.id,
                contactId: enrollment.contactId,
                organizationId: contact?.organizationId || null,
                campaignId: campaign.id,
                sequenceId: enrollment.sequenceId,
                enrollmentId: enrollment.id,
                subject: renderedSubject,
                status: 'OPEN',
                priority: 'NORMAL',
                latestMessageAt: new Date(),
                latestMessagePreview: cleanText.slice(0, 100) + (cleanText.length > 100 ? '...' : ''),
                latestMessageDirection: 'OUTBOUND',
                lastOutboundAt: new Date(),
                internetMessageThreadId: parentInternetMessageId || internetMessageId,
                providerThreadId: parentProviderThreadId || null
              }
            });
          } else {
            await prisma.conversation.update({
              where: { id: conv.id },
              data: {
                latestMessageAt: new Date(),
                latestMessagePreview: cleanText.slice(0, 100) + (cleanText.length > 100 ? '...' : ''),
                latestMessageDirection: 'OUTBOUND',
                lastOutboundAt: new Date()
              }
            });
          }

          const cleanBodyText = renderedBody.replace(/<[^>]*>?/gm, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
          await prisma.conversationMessage.create({
            data: {
              conversationId: conv.id,
              emailMessageId: message.id,
              direction: 'OUTBOUND',
              messageType: 'EMAIL',
              internetMessageId,
              providerMessageId,
              inReplyToMessageId: parentInternetMessageId || null,
              senderName: mailbox.displayName || mailbox.email,
              senderEmail: mailbox.email,
              recipientEmails: [primaryEmail],
              subject: renderedSubject,
              bodyText: cleanBodyText,
              bodyHtml: renderedBody,
              isRead: true,
              sentAt: new Date(),
              metadata: {
                inReplyTo: parentInternetMessageId || null,
                references: parentReferences || null,
                providerThreadId: parentProviderThreadId || null
              }
            }
          });
        } catch (convErr) {
          console.warn('Could not register campaign email in Unibox:', convErr);
        }

        // 9. Mark Sent in DB with Transport & Delivery Semantics
        await prisma.emailMessage.update({
          where: { id: message.id },
          data: {
            status: 'sent',
            sentAt: new Date(),
            providerMessageId,
            internetMessageId,
            transportStatus: 'SMTP_ACCEPTED',
            deliveryConfidence: 'DELIVERY_INFERRED',
            smtpAcceptedAt: new Date(),
            smtpResponseCode: smtpCode || '250',
            smtpResponse: rawSmtpResponse ? rawSmtpResponse.slice(0, 255) : '250 OK (Accepted)'
          }
        });

        await prisma.emailEvent.create({
          data: {
            emailMessageId: message.id,
            campaignId: campaign.id,
            enrollmentId: enrollment.id,
            contactId: enrollment.contactId,
            eventType: 'email.sent',
            eventAt: new Date(),
          }
        });

        await prisma.auditLog.create({
          data: {
            campaignId: campaign.id,
            action: 'Email Dispatched',
            details: `Step ${step.stepNumber} sent to ${primaryEmail} via ${mailbox.email}.`,
            createdAt: new Date(),
          }
        }).catch(() => {});

        mailboxSentThisTick++;
        ts.emailsSent++;

        // 10. Advance Enrollment
        const isBulk = campaign.campaignType === 'BULK_EMAIL';
        const nextStep = await prisma.sequenceStep.findFirst({
          where: { sequenceId: enrollment.sequenceId, stepNumber: step.stepNumber + 1 }
        });

        const mbTz = mailbox.sendingTimezone || 'Asia/Kolkata';
        const remMinHour = getMinutesRemainingInHour(new Date(), mbTz);
        const remMinWindow = getMinutesRemainingInWindow(mailbox, new Date());
        const effectiveRemMins = Math.max(1, Math.min(remMinHour, remMinWindow));

        const delaySeconds = calculatePacedDelaySeconds(
          mailbox.hourlySendLimit || 20,
          1,
          Math.max(0, (precomputedCap ?? 20) - mailboxSentThisTick),
          effectiveRemMins,
          !!options.force
        );
        let nextSendTime: Date | null = null;

        if (nextStep) {
          if (options.force) {
            nextSendTime = new Date(Date.now() + 5000);
          } else {
            const timezone = mailbox?.sendingTimezone || campaign.timezone || 'Asia/Kolkata';
            const effectiveSendingDays = resolveEffectiveSendingDays({
              campaignDays: campaign.sendingDays,
              mailboxDays: mailbox?.sendingDays
            });

            nextSendTime = calculateNextEligibleSendTime({
              from: new Date(),
              delayDays: Number(nextStep.delayDays ?? 0),
              sendingDays: effectiveSendingDays,
              sendingWindowStart: mailbox?.sendingStartTime || campaign.sendingWindowStart || '09:30',
              sendingWindowEnd: mailbox?.sendingEndTime || campaign.sendingWindowEnd || '17:30',
              timezone
            });

            if (!nextSendTime && effectiveSendingDays.length === 0) {
              console.warn(
                `[Scheduler] Enrollment ${enrollment.id} (Campaign "${campaign.name}", Mailbox "${mailbox.email}") ` +
                `has no overlapping eligible sending days between campaign and mailbox. Sequence follow-up held (nextSendAt: null).`
              );
            }
          }
        }

        const newStatus = nextStep ? 'active' : (isBulk ? 'sent' : 'completed');
        
        await prisma.enrollment.update({
          where: { id: enrollment.id },
          data: {
            mailboxId: enrollment.mailboxId || mailbox.id,
            currentStep: nextStep ? nextStep.stepNumber : step.stepNumber,
            status: newStatus,
            lastSentAt: new Date(),
            nextSendAt: nextSendTime,
          }
        });

        // 11. Update Mailbox counters & cooldown with dynamic ground truth
        const bounds = getCalendarBucketBounds(new Date(), mailbox.sendingTimezone || 'Asia/Kolkata');
        const latestCounts = await getDispatchedMessageCounts({
          mailboxEmail: mailbox.email,
          campaignId: campaign.id,
          startOfHour: bounds.startOfHour,
          endOfHour: bounds.endOfHour,
          startOfDay: bounds.startOfDay,
          endOfDay: bounds.endOfDay
        }, prisma);

        await prisma.mailbox.update({
          where: { id: mailbox.id },
          data: {
            emailsSentToday: latestCounts.mailboxSentToday,
            emailsSentThisHour: latestCounts.mailboxSentThisHour,
            lastSentAt: new Date(),
            nextAvailableSendAt: new Date(Date.now() + delaySeconds * 1000)
          }
        });

      } catch (error: any) {
        mailboxFailed++;
        ts.failed++;
        console.error(`[Scheduler] Error processing enrollment ${enrollment.id}:`, error);
        if (message?.id) {
          const errCodeMatch = (error?.message || '').match(/\b([45]\d\d)\b/);
          await prisma.emailMessage.update({
            where: { id: message.id },
            data: {
              status: 'failed',
              failedAt: new Date(),
              failureReason: (error?.message || 'SENDING_FAILED').slice(0, 255),
              transportStatus: 'FAILED',
              deliveryConfidence: 'UNKNOWN',
              smtpResponseCode: errCodeMatch ? errCodeMatch[1] : (error?.responseCode ? String(error.responseCode) : '550'),
              smtpResponse: (error?.response || error?.message || 'SMTP transport failure').slice(0, 255)
            }
          }).catch(() => {});
        }
        const isBulk = campaign.campaignType === 'BULK_EMAIL';
        await prisma.enrollment.update({
          where: { id: enrollment.id },
          data: {
            status: isBulk ? 'failed' : enrollment.status,
            failureCount: { increment: 1 },
            lastError: 'SENDING_FAILED'
          }
        });
      } finally {
        // Release Enrollment Lock
        await prisma.enrollment.updateMany({
          where: { id: enrollment.id, lockedBy: workerId },
          data: { lockedAt: null, lockedBy: null, lockExpiresAt: null }
        });
      }
    }
  } finally {
    // Release Mailbox Advisory Lock
    await releaseMailboxLock(mailbox.id);
  }

  return { sent: mailboxSentThisTick, skipped: mailboxSkipped, failed: mailboxFailed };
}
