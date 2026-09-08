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

  // 1. Gather all TripGain Outbound Messages & Outreach Prospects
  const outboundMessages = await prisma.conversationMessage.findMany({
    where: { direction: 'OUTBOUND' },
    select: {
      conversationId: true,
      internetMessageId: true,
      providerMessageId: true,
      recipientEmails: true,
      subject: true
    }
  });

  // Map Message-IDs to their parent TripGain conversation
  const outboundIdsToConversation = new Map<string, string>();
  const outreachRecipientsToConversation = new Map<string, string>();

  for (const msg of outboundMessages) {
    if (msg.internetMessageId) {
      outboundIdsToConversation.set(cleanHeaderId(msg.internetMessageId), msg.conversationId);
    }
    if (msg.providerMessageId) {
      outboundIdsToConversation.set(cleanHeaderId(msg.providerMessageId), msg.conversationId);
    }
    const recs = Array.isArray(msg.recipientEmails) ? msg.recipientEmails : [];
    for (const r of recs) {
      if (typeof r === 'string' && r.includes('@')) {
        outreachRecipientsToConversation.set(r.trim().toLowerCase(), msg.conversationId);
      }
    }
  }

  // Also gather contacts actively enrolled in TripGain campaigns
  const enrolledContacts = await prisma.enrollment.findMany({
    select: {
      id: true,
      campaignId: true,
      sequenceId: true,
      contact: {
        include: {
          emails: true,
          organization: true,
          conversations: true
        }
      }
    }
  });

  const enrolledEmailsMap = new Map<string, any>();
  for (const enr of enrolledContacts) {
    for (const em of enr.contact?.emails || []) {
      if (em.normalizedEmail) {
        enrolledEmailsMap.set(em.normalizedEmail.toLowerCase(), enr);
      }
    }
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
          // STRICT FILTER: IS THIS A REPLY TO A TRIPGAIN EMAIL?
          // ========================================================
          const inReplyToClean = cleanHeaderId(inReplyTo);
          const references = Array.isArray(parsed.references)
            ? parsed.references.map(cleanHeaderId)
            : [cleanHeaderId(parsed.references)];

          let matchedConvId = outboundIdsToConversation.get(inReplyToClean);
          if (!matchedConvId) {
            for (const ref of references) {
              if (ref && outboundIdsToConversation.has(ref)) {
                matchedConvId = outboundIdsToConversation.get(ref);
                break;
              }
            }
          }

          // If no direct Message-ID match, check if sender is a prospect we contacted
          if (!matchedConvId && outreachRecipientsToConversation.has(senderEmail)) {
            matchedConvId = outreachRecipientsToConversation.get(senderEmail);
          }

          let matchedEnrollment = null;
          let matchedContact = null;

          if (!matchedConvId && enrolledEmailsMap.has(senderEmail)) {
            const enrData = enrolledEmailsMap.get(senderEmail);
            matchedEnrollment = enrData;
            matchedContact = enrData.contact;
            if (enrData.contact?.conversations?.[0]?.id) {
              matchedConvId = enrData.contact.conversations[0].id;
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

    return {
      success: true,
      syncedCount,
      newConversations,
      details: `Checked Gmail. Synced ${syncedCount} new reply message(s) to your TripGain outreach.`
    };
  } catch (err: any) {
    console.error('Outreach IMAP sync error:', err);
    return {
      success: false,
      syncedCount,
      newConversations,
      error: err?.message || 'Failed to sync replies with Gmail'
    };
  }
}
