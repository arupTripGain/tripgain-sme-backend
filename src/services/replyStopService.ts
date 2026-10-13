import { PrismaClient } from '@prisma/client';

const defaultPrisma = new PrismaClient();

export interface HeaderMatchResult {
  matched: boolean;
  emailMessageId?: string | undefined;
  conversationMessageId?: string | undefined;
  enrollmentId?: string | undefined;
  contactId?: string | undefined;
  campaignId?: string | undefined;
  recipientEmail?: string | undefined;
}

export interface ContactResolutionResult {
  contactId: string | null;
  contactEmail: string | null;
  matchedVia: 'HEADER_THREAD' | 'DIRECT_CONTACT_EMAIL' | 'RECENT_OUTBOUND_EMAIL' | 'NONE';
  isAlias?: boolean | undefined;
}

export interface StopEnrollmentResult {
  stoppedEnrollmentCount: number;
  stoppedEnrollmentIds: string[];
  contactId: string;
  reason: string;
}

export interface SendSafetyCheckResult {
  stopped: boolean;
  reason?: string | undefined;
}

/**
 * Normalizes an email header message ID into all candidate formats:
 * - With angle brackets (e.g. "<msg_123@domain.com>")
 * - Without angle brackets (e.g. "msg_123@domain.com")
 */
export function normalizeHeaderIds(rawIds: (string | null | undefined)[]): string[] {
  const result = new Set<string>();

  for (const raw of rawIds) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Add exact trimmed
    result.add(trimmed);

    // Stripped version
    const stripped = trimmed.replace(/^<+|>+$/g, '').trim();
    if (stripped) {
      result.add(stripped);
      result.add(stripped.toLowerCase());
      // Angle bracketed version
      result.add(`<${stripped}>`);
      result.add(`<${stripped.toLowerCase()}>`);
    }
  }

  return Array.from(result);
}

/**
 * Finds an outbound EmailMessage or ConversationMessage matching candidate In-Reply-To / References header IDs.
 */
export async function findOutboundMessageByHeaders(
  headerIds: (string | null | undefined)[],
  prismaClient: any = defaultPrisma
): Promise<HeaderMatchResult> {
  const normalized = normalizeHeaderIds(headerIds);
  if (normalized.length === 0) {
    return { matched: false };
  }

  // 1. Check EmailMessage first (authoritative source of sequence outreach dispatch)
  const matchedEmailMsg = await prismaClient.emailMessage.findFirst({
    where: {
      OR: [
        { internetMessageId: { in: normalized } },
        { providerMessageId: { in: normalized } }
      ]
    },
    select: {
      id: true,
      enrollmentId: true,
      contactId: true,
      campaignId: true,
      toEmail: true,
      internetMessageId: true,
      providerMessageId: true
    }
  });

  if (matchedEmailMsg) {
    return {
      matched: true,
      emailMessageId: matchedEmailMsg.id,
      enrollmentId: matchedEmailMsg.enrollmentId || undefined,
      contactId: matchedEmailMsg.contactId || undefined,
      campaignId: matchedEmailMsg.campaignId || undefined,
      recipientEmail: matchedEmailMsg.toEmail || undefined
    };
  }

  // 2. Check ConversationMessage as fallback
  const matchedConvMsg = await prismaClient.conversationMessage.findFirst({
    where: {
      direction: 'OUTBOUND',
      OR: [
        { internetMessageId: { in: normalized } },
        { providerMessageId: { in: normalized } }
      ]
    },
    select: {
      id: true,
      conversationId: true,
      emailMessageId: true,
      recipientEmails: true,
      conversation: {
        select: {
          id: true,
          contactId: true,
          enrollmentId: true,
          campaignId: true
        }
      }
    }
  });

  if (matchedConvMsg) {
    const recipients = Array.isArray(matchedConvMsg.recipientEmails) ? matchedConvMsg.recipientEmails : [];
    return {
      matched: true,
      conversationMessageId: matchedConvMsg.id,
      emailMessageId: matchedConvMsg.emailMessageId || undefined,
      enrollmentId: matchedConvMsg.conversation?.enrollmentId || undefined,
      contactId: matchedConvMsg.conversation?.contactId || undefined,
      campaignId: matchedConvMsg.conversation?.campaignId || undefined,
      recipientEmail: typeof recipients[0] === 'string' ? recipients[0] : undefined
    };
  }

  return { matched: false };
}

/**
 * Resolves contact associated with an inbound message using headers, contact emails, aliases, and recent sends.
 */
export async function resolveProspectContact(
  senderEmail: string,
  headerMatch: HeaderMatchResult,
  prismaClient: any = defaultPrisma
): Promise<ContactResolutionResult> {
  const senderNorm = senderEmail.trim().toLowerCase();

  // 1. Direct ContactEmail lookup
  const directEmail = await prismaClient.contactEmail.findFirst({
    where: {
      OR: [
        { normalizedEmail: senderNorm },
        { email: { equals: senderNorm, mode: 'insensitive' } }
      ]
    },
    select: { contactId: true, normalizedEmail: true }
  });

  if (directEmail?.contactId) {
    return {
      contactId: directEmail.contactId,
      contactEmail: directEmail.normalizedEmail,
      matchedVia: 'DIRECT_CONTACT_EMAIL'
    };
  }

  // 2. Header match was successful: link to contact from outbound message even if sender is an alias
  if (headerMatch.matched && headerMatch.contactId) {
    // Check if senderNorm should be registered as a recognized alias/email for this contact
    try {
      const existing = await prismaClient.contactEmail.findFirst({
        where: {
          contactId: headerMatch.contactId,
          normalizedEmail: senderNorm
        }
      });
      if (!existing) {
        await prismaClient.contactEmail.create({
          data: {
            contactId: headerMatch.contactId,
            email: senderEmail.trim(),
            normalizedEmail: senderNorm,
            emailType: 'alias_reply',
            isPrimary: false,
            isValid: true,
            verificationStatus: 'verified'
          }
        });
      }
    } catch {
      // Ignore conflict if created concurrently
    }

    return {
      contactId: headerMatch.contactId,
      contactEmail: headerMatch.recipientEmail || senderNorm,
      matchedVia: 'HEADER_THREAD',
      isAlias: true
    };
  }

  // 3. Fallback: Lookup recent outbound EmailMessage where toEmail == senderNorm
  const recentOutbound = await prismaClient.emailMessage.findFirst({
    where: {
      toEmail: { equals: senderNorm, mode: 'insensitive' }
    },
    select: { contactId: true, toEmail: true },
    orderBy: { createdAt: 'desc' }
  });

  if (recentOutbound?.contactId) {
    return {
      contactId: recentOutbound.contactId,
      contactEmail: recentOutbound.toEmail,
      matchedVia: 'RECENT_OUTBOUND_EMAIL'
    };
  }

  return {
    contactId: null,
    contactEmail: null,
    matchedVia: 'NONE'
  };
}

/**
 * Checks whether an inbound email sender is internal (mailbox itself or internal system).
 */
export async function isInternalSender(
  senderEmail: string,
  currentMailboxEmail: string,
  prismaClient: any = defaultPrisma
): Promise<boolean> {
  const norm = senderEmail.trim().toLowerCase();
  const mbNorm = currentMailboxEmail.trim().toLowerCase();

  if (!norm) return true;
  if (norm === mbNorm) return true;

  // Check if sender matches any active workspace mailbox
  const matchedMailbox = await prismaClient.mailbox.findFirst({
    where: {
      email: { equals: norm, mode: 'insensitive' }
    },
    select: { id: true }
  });

  return Boolean(matchedMailbox);
}

/**
 * Concurrency-safe and idempotent action to stop all active follow-up sequence enrollments
 * for a prospect upon a confirmed reply.
 */
export async function stopEnrollmentsOnProspectReply(params: {
  contactId: string;
  enrollmentId?: string | undefined;
  replyDate?: Date | undefined;
  senderEmail?: string | undefined;
  mailboxEmail?: string | undefined;
  internetMessageId?: string | undefined;
  prismaClient?: any;
}): Promise<StopEnrollmentResult> {
  const prisma = params.prismaClient || defaultPrisma;
  const replyDate = params.replyDate || new Date();
  const stopReason = 'REPLY_RECEIVED';

  // 1. Identify all active, pending, or held sequence enrollments for this contact
  const activeEnrollments = await prisma.enrollment.findMany({
    where: {
      contactId: params.contactId,
      status: { in: ['pending', 'active', 'sending', 'held'] }
    },
    select: { id: true, campaignId: true, sequenceId: true, status: true }
  });

  const stoppedIds: string[] = [];

  if (activeEnrollments.length > 0) {
    const ids = activeEnrollments.map((e: any) => e.id);
    await prisma.enrollment.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'replied',
        stoppedAt: replyDate,
        stopReason,
        nextSendAt: null // Explicitly cancel future scheduled ticks
      }
    });
    stoppedIds.push(...ids);
  }

  // Also ensure the specific enrollmentId is marked replied if passed
  if (params.enrollmentId && !stoppedIds.includes(params.enrollmentId)) {
    const specific = await prisma.enrollment.findUnique({
      where: { id: params.enrollmentId },
      select: { id: true, status: true }
    });
    if (specific && specific.status !== 'replied') {
      await prisma.enrollment.update({
        where: { id: params.enrollmentId },
        data: {
          status: 'replied',
          stoppedAt: replyDate,
          stopReason,
          nextSendAt: null
        }
      });
      stoppedIds.push(params.enrollmentId);
    }
  }

  // 2. Mark latest outbound EmailMessage as replied
  const latestOutbound = await prisma.emailMessage.findFirst({
    where: {
      contactId: params.contactId,
      status: { in: ['sent', 'delivered', 'opened', 'clicked'] }
    },
    orderBy: { sentAt: 'desc' }
  });

  if (latestOutbound) {
    await prisma.emailMessage.update({
      where: { id: latestOutbound.id },
      data: {
        status: 'replied',
        repliedAt: replyDate,
        lastEventAt: replyDate,
        deliveryConfidence: 'ENGAGEMENT_CONFIRMED'
      }
    });

    // 3. Idempotently create EmailEvent for replied analytics
    const existingEvent = await prisma.emailEvent.findFirst({
      where: {
        emailMessageId: latestOutbound.id,
        eventType: 'replied'
      }
    });

    if (!existingEvent) {
      await prisma.emailEvent.create({
        data: {
          provider: 'IMAP',
          eventType: 'replied',
          emailMessageId: latestOutbound.id,
          contactId: params.contactId,
          campaignId: latestOutbound.campaignId,
          enrollmentId: latestOutbound.enrollmentId,
          senderEmail: params.senderEmail || latestOutbound.toEmail,
          recipientEmail: params.mailboxEmail || latestOutbound.fromEmail,
          eventAt: replyDate
        }
      });
    }
  }

  // Safe structured log (no bodies, no passwords)
  console.log(
    `[REPLY_STOP] Contact ${params.contactId} prospect reply confirmed. ` +
    `Stopped ${stoppedIds.length} sequence enrollment(s) [${stoppedIds.join(', ')}].`
  );

  return {
    stoppedEnrollmentCount: stoppedIds.length,
    stoppedEnrollmentIds: stoppedIds,
    contactId: params.contactId,
    reason: stopReason
  };
}

/**
 * Concurrency-safe and atomic check to verify whether an enrollment or contact
 * has stopped due to a prospect reply.
 * Used as a pre-flight guard in schedulerService and all sending paths immediately before SMTP dispatch.
 */
export async function isEnrollmentStoppedDueToReply(
  enrollmentId: string,
  contactId?: string | null,
  prismaClient: any = defaultPrisma
): Promise<SendSafetyCheckResult> {
  const enrollment = await prismaClient.enrollment.findUnique({
    where: { id: enrollmentId },
    select: {
      id: true,
      contactId: true,
      status: true,
      stopReason: true,
      stoppedAt: true
    }
  });

  if (!enrollment) {
    return { stopped: true, reason: 'ENROLLMENT_NOT_FOUND' };
  }

  // 1. Direct status check on enrollment
  if (enrollment.status === 'replied') {
    return { stopped: true, reason: 'REPLY_RECEIVED' };
  }

  const effectiveReason = (enrollment.stopReason || '').toUpperCase();
  if (effectiveReason.includes('REPLY')) {
    return { stopped: true, reason: 'REPLY_RECEIVED' };
  }

  if (enrollment.status === 'stopped' || enrollment.status === 'bounced' || enrollment.status === 'unsubscribed' || enrollment.status === 'completed') {
    return { stopped: true, reason: enrollment.stopReason || enrollment.status.toUpperCase() };
  }

  const targetContactId = contactId || enrollment.contactId;
  if (!targetContactId) {
    return { stopped: false };
  }

  // 2. Check if contact has ANY other enrollment marked replied
  const otherRepliedEnrollment = await prismaClient.enrollment.findFirst({
    where: {
      contactId: targetContactId,
      OR: [
        { status: 'replied' },
        { stopReason: { contains: 'reply', mode: 'insensitive' } }
      ]
    },
    select: { id: true, status: true, stopReason: true }
  });

  if (otherRepliedEnrollment) {
    return { stopped: true, reason: 'REPLY_RECEIVED' };
  }

  // 3. Check if contact has ANY inbound ConversationMessage (prospect replied)
  const inboundMsg = await prismaClient.conversationMessage.findFirst({
    where: {
      direction: 'INBOUND',
      conversation: { contactId: targetContactId }
    },
    select: { id: true }
  });

  if (inboundMsg) {
    return { stopped: true, reason: 'REPLY_RECEIVED' };
  }

  // 4. Check if contact has ANY replied EmailEvent
  const repliedEvent = await prismaClient.emailEvent.findFirst({
    where: {
      contactId: targetContactId,
      eventType: { in: ['replied', 'email.replied', 'REPLIED'] }
    },
    select: { id: true }
  });

  if (repliedEvent) {
    return { stopped: true, reason: 'REPLY_RECEIVED' };
  }

  // 5. Check if contact has ANY EmailMessage with repliedAt != null or status == 'replied'
  const repliedMessage = await prismaClient.emailMessage.findFirst({
    where: {
      contactId: targetContactId,
      OR: [
        { status: 'replied' },
        { repliedAt: { not: null } }
      ]
    },
    select: { id: true }
  });

  if (repliedMessage) {
    return { stopped: true, reason: 'REPLY_RECEIVED' };
  }

  return { stopped: false };
}
