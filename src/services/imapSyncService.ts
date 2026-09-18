import { PrismaClient } from '@prisma/client';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { decrypt } from '../controllers/mailboxController';

const prisma = new PrismaClient();

export interface SyncResult {
  success: boolean;
  syncedCount: number;
  newConversations: number;
  details?: string;
  error?: string;
}

export interface BounceClassification {
  isBounce: boolean;
  bounceType: 'hard' | 'soft' | 'unknown';
  targetEmail: string | null;
  dsnCode?: string | undefined;
  reason?: string | undefined;
}

export function classifyBounce(
  senderEmail: string,
  subject: string,
  bodyText: string,
  knownProspectEmails: string[] = []
): BounceClassification {
  const sEmail = (senderEmail || '').toLowerCase();
  const subj = (subject || '').toLowerCase();
  const text = (bodyText || '').toLowerCase();

  const isBounceSender = sEmail.includes('mailer-daemon') || sEmail.includes('postmaster') || sEmail.includes('mail-daemon') || sEmail.includes('bounce');
  const isBounceSubject = /delivery status notification|undelivered mail|mail delivery failed|returned mail|failure notice|delivery failure|undeliverable/i.test(subj);

  if (!isBounceSender && !isBounceSubject) {
    return { isBounce: false, bounceType: 'unknown', targetEmail: null };
  }

  // Find which of our prospect emails is mentioned in the bounce message
  let targetEmail: string | null = null;
  for (const email of knownProspectEmails) {
    if (text.includes(email.toLowerCase())) {
      targetEmail = email.toLowerCase();
      break;
    }
  }

  // Fallback: extract email following "Final-Recipient:", "message to", etc.
  if (!targetEmail) {
    const finalRecMatch = text.match(/(?:final-recipient:\s*(?:rfc822;\s*)?|(?:failed|message|delivery|undelivered|recipient)\s+(?:to|for)?\s*:?\s*)<?([^\s<;]+@[^\s>;]+)>?/i);
    if (finalRecMatch && finalRecMatch[1]) {
      targetEmail = finalRecMatch[1].trim().toLowerCase().replace(/[>.,;:]$/, '');
    }
  }

  const isHard = /5\.\d+\.\d+|user unknown|no such user|does not exist|invalid recipient|permanent failure|address rejected|recipient rejected|mailbox unavailable|account disabled|domain not found/i.test(subj + ' ' + text);
  const isSoft = /4\.\d+\.\d+|mailbox full|quota exceeded|try again later|server busy|temporarily deferred|temporarily unavailable|message size exceeds/i.test(subj + ' ' + text);

  let bounceType: 'hard' | 'soft' | 'unknown' = 'unknown';
  if (isHard) {
    bounceType = 'hard';
  } else if (isSoft) {
    bounceType = 'soft';
  } else {
    bounceType = 'unknown';
  }

  const dsnMatch = (subj + ' ' + text).match(/(?:status:?\s*|code:?\s*|\b)([45]\.\d+\.\d+)\b/i);

  return {
    isBounce: true,
    bounceType,
    targetEmail,
    dsnCode: dsnMatch ? dsnMatch[1] : undefined,
    reason: isHard ? 'Permanent address failure' : (isSoft ? 'Temporary delivery deferral' : 'Unclassified delivery failure')
  };
}

function cleanHeaderId(id?: string | null): string {
  if (!id) return '';
  return id.replace(/^<+|>+$/g, '').trim().toLowerCase();
}

/**
 * Strictly syncs ONLY replies to emails sent by TripGain Outreach.
 * Unrelated Gmail inbox messages (Google alerts, personal emails, newsletters, incoming sales pitches)
 * are strictly ignored and never imported into Unibox.
 */
export async function syncMailboxReplies(mailboxId?: string): Promise<SyncResult> {
  const mailbox = await prisma.mailbox.findFirst({
    where: mailboxId ? { id: mailboxId } : { status: 'CONNECTED', isActive: true },
    include: { credentials: true }
  });

  if (!mailbox || !mailbox.credentials) {
    return { success: false, syncedCount: 0, newConversations: 0, error: 'No active connected mailbox with credentials found' };
  }

  const { credentials } = mailbox;
  const imapHost = credentials.encryptedImapHost ? decrypt(credentials.encryptedImapHost) : 'imap.gmail.com';
  const imapPort = credentials.encryptedImapPort ? Number(decrypt(credentials.encryptedImapPort)) : 993;
  const imapUser = credentials.encryptedImapUsername ? decrypt(credentials.encryptedImapUsername) : mailbox.email;
  const imapPass = credentials.encryptedImapPassword ? decrypt(credentials.encryptedImapPassword) : '';

  if (!imapPass) {
    return { success: false, syncedCount: 0, newConversations: 0, error: 'IMAP password not available' };
  }

  const client = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: imapPort === 993,
    auth: {
      user: imapUser,
      pass: imapPass
    },
    logger: false,
    emitLogs: false
  });

  let syncedCount = 0;
  let newConversations = 0;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - 14); // Check last 14 days for replies

      const searchCriteria: any = { since: sinceDate };
      const messageList = await client.search(searchCriteria, { uid: true });
      const uidsToFetch = Array.isArray(messageList) ? messageList.slice(-50) : [];

      for (const uid of uidsToFetch) {
        try {
          const download = await client.download(String(uid), undefined, { uid: true });
          if (!download || !download.content) continue;

          const parsed = await simpleParser(download.content);

          const senderEmail = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
          const rawSenderName = parsed.from?.value?.[0]?.name || parsed.from?.text || senderEmail;
          const senderName = rawSenderName || senderEmail;
          const subject = parsed.subject || 'Re: Outreach';
          const bodyText = parsed.text || parsed.html || '';
          const bodyHtml = parsed.html ? String(parsed.html) : null;
          const messageIdHeader = parsed.messageId || null;
          const inReplyTo = parsed.inReplyTo || null;
          const receivedDate = parsed.date || new Date();

          // Skip if sent by the mailbox itself (outbound)
          if (senderEmail === mailbox.email.toLowerCase()) {
            continue;
          }

          if (!senderEmail) continue;

          // ========================================================
          // 1. BOUNCE PROCESSING (Hard bounce vs Soft bounce vs Unknown)
          // ========================================================
          const bounceInfo = classifyBounce(senderEmail, subject, bodyText);

          if (bounceInfo.isBounce && bounceInfo.targetEmail) {
            const targetNorm = bounceInfo.targetEmail.toLowerCase();
            
            // Targeted lookup for bounced contact email & contact
            const targetContactEmail = await prisma.contactEmail.findFirst({
              where: { normalizedEmail: targetNorm },
              select: { id: true, contactId: true }
            });
            const contactId = targetContactEmail?.contactId;

            const emailMessage = await prisma.emailMessage.findFirst({
              where: {
                toEmail: { equals: targetNorm, mode: 'insensitive' },
                status: { in: ['sent', 'delivered', 'pending', 'queued'] }
              },
              orderBy: { sentAt: 'desc' }
            });

            if (bounceInfo.bounceType === 'hard') {
              // 3A: HARD BOUNCE: mark message bounced, mark enrollment bounced, suppress address, block future sends
              if (emailMessage) {
                await prisma.emailMessage.update({
                  where: { id: emailMessage.id },
                  data: {
                    status: 'bounced',
                    bouncedAt: receivedDate,
                    lastEventAt: receivedDate,
                    transportStatus: 'BOUNCED',
                    deliveryConfidence: 'UNKNOWN',
                    bounceType: 'hard',
                    bounceCode: bounceInfo.dsnCode || '5.0.0',
                    bounceReason: (bounceInfo.reason || 'Permanent address failure').slice(0, 255)
                  }
                });

                await prisma.emailEvent.create({
                  data: {
                    provider: 'IMAP_DSN',
                    eventType: 'bounced',
                    emailMessageId: emailMessage.id,
                    contactId: emailMessage.contactId,
                    campaignId: emailMessage.campaignId,
                    enrollmentId: emailMessage.enrollmentId,
                    recipientEmail: targetNorm,
                    senderEmail: mailbox.email,
                    metadata: { bounceType: 'hard', dsnCode: bounceInfo.dsnCode, reason: bounceInfo.reason },
                    eventAt: receivedDate
                  }
                });
              }

              if (contactId) {
                await prisma.enrollment.updateMany({
                  where: { contactId, status: { in: ['pending', 'active', 'sending'] } },
                  data: {
                    status: 'bounced',
                    stoppedAt: receivedDate,
                    stopReason: 'HARD_BOUNCE'
                  }
                });

                await prisma.contactEmail.updateMany({
                  where: { normalizedEmail: targetNorm },
                  data: { verificationStatus: 'bounced', bounceCount: { increment: 1 }, lastBouncedAt: receivedDate }
                });
              }

              // Add to suppression list
              await prisma.suppressionList.upsert({
                where: { normalizedEmail: targetNorm },
                update: { reason: 'hard_bounce', suppressedAt: receivedDate },
                create: {
                  email: targetNorm,
                  normalizedEmail: targetNorm,
                  reason: 'hard_bounce',
                  userId: mailbox.userId,
                  suppressedAt: receivedDate
                }
              });

              syncedCount++;
              continue;
            } else if (bounceInfo.bounceType === 'soft') {
              // 3B: SOFT BOUNCE: mark message soft_bounced, mark enrollment soft_bounced, STOP further sending, NO auto-retry, NOT permanently suppressed
              if (emailMessage) {
                await prisma.emailMessage.update({
                  where: { id: emailMessage.id },
                  data: {
                    status: 'soft_bounced',
                    bouncedAt: receivedDate,
                    lastEventAt: receivedDate,
                    transportStatus: 'BOUNCED',
                    deliveryConfidence: 'UNKNOWN',
                    bounceType: 'soft',
                    bounceCode: bounceInfo.dsnCode || '4.0.0',
                    bounceReason: (bounceInfo.reason || 'Temporary delivery deferral').slice(0, 255)
                  }
                });

                await prisma.emailEvent.create({
                  data: {
                    provider: 'IMAP_DSN',
                    eventType: 'soft_bounced',
                    emailMessageId: emailMessage.id,
                    contactId: emailMessage.contactId,
                    campaignId: emailMessage.campaignId,
                    enrollmentId: emailMessage.enrollmentId,
                    recipientEmail: targetNorm,
                    senderEmail: mailbox.email,
                    metadata: { bounceType: 'soft', dsnCode: bounceInfo.dsnCode, reason: bounceInfo.reason },
                    eventAt: receivedDate
                  }
                });
              }

              if (contactId) {
                await prisma.enrollment.updateMany({
                  where: { contactId, status: { in: ['pending', 'active', 'sending'] } },
                  data: {
                    status: 'soft_bounced',
                    stoppedAt: receivedDate,
                    stopReason: 'SOFT_BOUNCE'
                  }
                });

                await prisma.contactEmail.updateMany({
                  where: { normalizedEmail: targetNorm },
                  data: { verificationStatus: 'soft_bounced', bounceCount: { increment: 1 }, lastBouncedAt: receivedDate }
                });
              }

              syncedCount++;
              continue;
            } else {
              // 3C: UNKNOWN DELIVERY FAILURE: FAIL CLOSED, record reason, mark failed, STOP sending, NO retry
              if (emailMessage) {
                await prisma.emailMessage.update({
                  where: { id: emailMessage.id },
                  data: {
                    status: 'failed',
                    failureReason: bounceInfo.reason || 'Unclassified delivery failure',
                    lastEventAt: receivedDate
                  }
                });

                await prisma.emailEvent.create({
                  data: {
                    provider: 'IMAP_DSN',
                    eventType: 'failed',
                    emailMessageId: emailMessage.id,
                    contactId: emailMessage.contactId,
                    campaignId: emailMessage.campaignId,
                    enrollmentId: emailMessage.enrollmentId,
                    recipientEmail: targetNorm,
                    senderEmail: mailbox.email,
                    metadata: { failureReason: bounceInfo.reason, source: 'IMAP_DSN' },
                    eventAt: receivedDate
                  }
                });
              }

              if (contactId) {
                await prisma.enrollment.updateMany({
                  where: { contactId, status: { in: ['pending', 'active', 'sending'] } },
                  data: {
                    status: 'failed',
                    stoppedAt: receivedDate,
                    stopReason: 'DELIVERY_FAILED_UNKNOWN'
                  }
                });
              }

              syncedCount++;
              continue;
            }
          }

          // ========================================================
          // STRICT FILTER: IS THIS A REPLY TO A TRIPGAIN EMAIL?
          // ========================================================
          const inReplyToClean = cleanHeaderId(inReplyTo);
          const references = (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
            .map(cleanHeaderId)
            .filter((r): r is string => Boolean(r && r.length > 0));

          const headerCandidateIds = Array.from(new Set([
            ...(inReplyToClean ? [inReplyToClean] : []),
            ...references
          ]));

          let matchedConvId: string | null = null;

          // 1. Thread matching by In-Reply-To or References header IDs
          if (headerCandidateIds.length > 0) {
            const matchedOutboundMsg = await prisma.conversationMessage.findFirst({
              where: {
                direction: 'OUTBOUND',
                OR: [
                  { internetMessageId: { in: headerCandidateIds } },
                  { providerMessageId: { in: headerCandidateIds } }
                ]
              },
              select: {
                id: true,
                conversationId: true,
                internetMessageId: true,
                providerMessageId: true
              }
            });

            if (matchedOutboundMsg?.conversationId) {
              matchedConvId = matchedOutboundMsg.conversationId;
            }
          }

          // 2. Targeted lookup: resolve contact by sender email
          const senderNorm = senderEmail.trim().toLowerCase();
          const matchedContactEmail = await prisma.contactEmail.findFirst({
            where: { normalizedEmail: senderNorm },
            select: {
              id: true,
              contactId: true,
              contact: {
                select: {
                  id: true,
                  organizationId: true
                }
              }
            }
          });

          const matchedContact = matchedContactEmail?.contact || null;

          // 3. Resolve active or recent enrollment for this contact
          let matchedEnrollment: {
            id: string;
            campaignId: string;
            sequenceId: string;
          } | null = null;

          if (matchedContact) {
            matchedEnrollment = await prisma.enrollment.findFirst({
              where: {
                contactId: matchedContact.id,
                status: { in: ['active', 'pending', 'sending', 'replied'] }
              },
              select: {
                id: true,
                campaignId: true,
                sequenceId: true
              },
              orderBy: { createdAt: 'desc' }
            });

            // 4. If conversation not matched by headers, check existing conversation for this contact
            if (!matchedConvId) {
              const existingContactConv = await prisma.conversation.findFirst({
                where: {
                  contactId: matchedContact.id,
                  mailboxId: mailbox.id
                },
                select: { id: true },
                orderBy: { latestMessageAt: 'desc' }
              });

              if (existingContactConv?.id) {
                matchedConvId = existingContactConv.id;
              } else {
                // Check across all mailboxes for fallback conversation
                const globalContactConv = await prisma.conversation.findFirst({
                  where: { contactId: matchedContact.id },
                  select: { id: true },
                  orderBy: { latestMessageAt: 'desc' }
                });
                if (globalContactConv?.id) {
                  matchedConvId = globalContactConv.id;
                }
              }
            }
          }

          // STRICT ENFORCEMENT:
          // If neither a header match nor an outreach prospect -> IGNORE COMPLETELY!
          if (!matchedConvId && !matchedContact) {
            continue;
          }

          // Check if we already imported this message into this conversation
          const existingMessage = await prisma.conversationMessage.findFirst({
            where: {
              OR: [
                messageIdHeader ? { providerMessageId: messageIdHeader } : {},
                {
                  senderEmail,
                  subject,
                  receivedAt: {
                    gte: new Date(receivedDate.getTime() - 60000),
                    lte: new Date(receivedDate.getTime() + 60000)
                  }
                }
              ]
            }
          });

          if (existingMessage) {
            continue; // Already processed
          }

          // Find or create conversation
          let conversation: any = null;
          if (matchedConvId) {
            conversation = await prisma.conversation.findUnique({
              where: { id: matchedConvId },
              include: { contact: true }
            });
          }

          if (!conversation && matchedContact) {
            conversation = await prisma.conversation.create({
              data: {
                mailboxId: mailbox.id,
                contactId: matchedContact.id,
                organizationId: matchedContact.organizationId || null,
                campaignId: matchedEnrollment?.campaignId || null,
                sequenceId: matchedEnrollment?.sequenceId || null,
                enrollmentId: matchedEnrollment?.id || null,
                subject,
                status: 'NEEDS_ACTION',
                priority: 'HIGH',
                unreadCount: 1,
                replyRequired: true,
                interestStatus: 'INTERESTED',
                latestMessageAt: receivedDate,
                latestMessagePreview: (bodyText || subject).substring(0, 60) + '...',
                latestMessageDirection: 'INBOUND',
                lastInboundAt: receivedDate
              }
            });
            newConversations++;
          } else if (conversation) {
            await prisma.conversation.update({
              where: { id: conversation.id },
              data: {
                status: 'NEEDS_ACTION',
                unreadCount: { increment: 1 },
                replyRequired: true,
                latestMessageAt: receivedDate,
                latestMessagePreview: (bodyText || subject).substring(0, 60) + '...',
                latestMessageDirection: 'INBOUND',
                lastInboundAt: receivedDate
              }
            });
          }

          if (!conversation) continue;

          // Save the inbound reply message
          await prisma.conversationMessage.create({
            data: {
              conversationId: conversation.id,
              providerMessageId: messageIdHeader,
              inReplyToMessageId: inReplyTo,
              direction: 'INBOUND',
              messageType: 'EMAIL',
              senderName: senderName || senderEmail,
              senderEmail,
              recipientEmails: [mailbox.email],
              subject,
              bodyText,
              bodyHtml,
              isRead: false,
              receivedAt: receivedDate
            }
          });

          // Stop sequence on campaign enrollment if active
          if (conversation.contactId) {
            await prisma.enrollment.updateMany({
              where: {
                contactId: conversation.contactId,
                status: { in: ['pending', 'active'] }
              },
              data: {
                status: 'replied',
                stoppedAt: receivedDate,
                stopReason: 'REPLY_RECEIVED'
              }
            });

            // Also update latest outbound EmailMessage and record replied EmailEvent for analytics
            const latestOutbound = await prisma.emailMessage.findFirst({
              where: {
                contactId: conversation.contactId,
                status: { in: ['sent', 'delivered', 'opened', 'clicked'] }
              },
              orderBy: { sentAt: 'desc' }
            });

            if (latestOutbound) {
              await prisma.emailMessage.update({
                where: { id: latestOutbound.id },
                data: {
                  status: 'replied',
                  repliedAt: receivedDate,
                  lastEventAt: receivedDate,
                  deliveryConfidence: 'ENGAGEMENT_CONFIRMED'
                }
              });

              await prisma.emailEvent.create({
                data: {
                  provider: 'IMAP',
                  eventType: 'replied',
                  emailMessageId: latestOutbound.id,
                  contactId: conversation.contactId,
                  campaignId: latestOutbound.campaignId,
                  enrollmentId: latestOutbound.enrollmentId,
                  senderEmail,
                  recipientEmail: mailbox.email,
                  eventAt: receivedDate
                }
              });
            }
          }

          syncedCount++;
        } catch (msgErr) {
          console.error(`Error processing UID ${uid}:`, msgErr);
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();

    await prisma.mailbox.update({
      where: { id: mailbox.id },
      data: {
        lastReplySyncAt: new Date(),
        replySyncStatus: 'ACTIVE',
        lastError: null
      }
    }).catch(() => {});

    return {
      success: true,
      syncedCount,
      newConversations,
      details: `Checked Gmail. Synced ${syncedCount} new reply message(s) to your TripGain outreach.`
    };
  } catch (err: any) {
    console.error('Outreach IMAP sync error:', err);
    await prisma.mailbox.update({
      where: { id: mailbox.id },
      data: {
        lastReplySyncAt: new Date(),
        replySyncStatus: 'ERROR',
        lastError: (err?.message || 'IMAP sync failure').slice(0, 255)
      }
    }).catch(() => {});

    return {
      success: false,
      syncedCount,
      newConversations,
      error: err?.message || 'Failed to sync replies with Gmail'
    };
  }
}

export interface InboundSyncSummary {
  mailboxesChecked: number;
  repliesSynced: number;
  newConversations: number;
  mailboxErrors: number;
  details: Array<{
    mailboxId: string;
    email: string;
    syncedCount: number;
    success: boolean;
    error?: string;
  }>;
}

/**
 * Periodically synchronizes inbound replies across all active connected mailboxes.
 * Uses bounded sequential processing to prevent IMAP connection floods and avoid Vercel timeouts.
 */
export async function syncAllActiveMailboxes(): Promise<InboundSyncSummary> {
  console.log('[Inbound Sync] Starting mailbox sync');

  const activeMailboxes = await prisma.mailbox.findMany({
    where: {
      status: 'CONNECTED',
      isActive: true,
      credentials: {
        encryptedImapPassword: { not: null }
      }
    },
    select: {
      id: true,
      email: true
    },
    orderBy: {
      lastReplySyncAt: 'asc' // Least recently synced first
    }
  });

  const summary: InboundSyncSummary = {
    mailboxesChecked: activeMailboxes.length,
    repliesSynced: 0,
    newConversations: 0,
    mailboxErrors: 0,
    details: []
  };

  if (activeMailboxes.length === 0) {
    console.log('[Inbound Sync] No active connected mailboxes with IMAP credentials found.');
    return summary;
  }

  for (const mb of activeMailboxes) {
    try {
      const res = await syncMailboxReplies(mb.id);
      if (res.success) {
        summary.repliesSynced += res.syncedCount;
        summary.newConversations += res.newConversations;
        console.log(`[Inbound Sync] Mailbox ${mb.email} synced ${res.syncedCount} replies`);
        summary.details.push({
          mailboxId: mb.id,
          email: mb.email,
          syncedCount: res.syncedCount,
          success: true
        });
      } else {
        summary.mailboxErrors++;
        console.warn(`[Inbound Sync] Mailbox sync failed for ${mb.email}: ${res.error || 'Unknown error'}`);
        summary.details.push({
          mailboxId: mb.id,
          email: mb.email,
          syncedCount: 0,
          success: false,
          error: res.error || 'Sync failed'
        });
      }
    } catch (err: any) {
      summary.mailboxErrors++;
      console.error(`[Inbound Sync] Mailbox sync failed for ${mb.email}: ${err?.message || 'Unknown error'}`);
      summary.details.push({
        mailboxId: mb.id,
        email: mb.email,
        syncedCount: 0,
        success: false,
        error: err?.message || 'Sync error'
      });
    }
  }

  console.log(`[Inbound Sync] Completed. Checked: ${summary.mailboxesChecked}, Synced: ${summary.repliesSynced} replies, Errors: ${summary.mailboxErrors}`);
  return summary;
}

