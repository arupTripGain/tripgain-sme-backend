import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import Handlebars from 'handlebars';
import { decrypt } from '../controllers/mailboxController';

const prisma = new PrismaClient();

// Utility for delay calculation (configurable or fallback to 10-30 seconds for active delivery)
function getRandomDelay(minSeconds = 15, maxAddSeconds = 15) {
  return minSeconds + Math.floor(Math.random() * maxAddSeconds);
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
// Capacity Check
// ---------------------------------------------------------------------
async function getMailboxCapacity(mailboxId: string, force = false) {
  const mailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) return { availableNow: 0, remainingDaily: 0, remainingHourly: 0 };
  
  const remainingDaily = Math.max(0, mailbox.dailySendLimit - mailbox.emailsSentToday);
  const remainingHourly = Math.max(0, mailbox.hourlySendLimit - mailbox.emailsSentThisHour);
  
  if (force) {
    return {
      remainingDaily: Math.max(remainingDaily, 50),
      remainingHourly: Math.max(remainingHourly, 50),
      availableNow: Math.max(Math.min(remainingDaily, remainingHourly), 50)
    };
  }

  return {
    remainingDaily,
    remainingHourly,
    availableNow: Math.min(remainingDaily, remainingHourly)
  };
}

// ---------------------------------------------------------------------
// Main Scheduler Loop
// ---------------------------------------------------------------------
export async function processEmailScheduler(options: { 
  force?: boolean | undefined; 
  bypassStepDelay?: boolean | undefined;
  campaignId?: string | undefined;
} = {}): Promise<{ emailsSent: number; emailsSkipped: number; emailsFailed: number }> {
  const workerId = crypto.randomUUID();
  let emailsSent = 0;
  let emailsSkipped = 0;
  let emailsFailed = 0;

  const isBypassingDelay = Boolean(options.force || options.bypassStepDelay);
  console.log(`[Scheduler] Starting run. Worker ID: ${workerId}, Force: ${!!options.force}, BypassDelay: ${isBypassingDelay}${options.campaignId ? `, Campaign: ${options.campaignId}` : ''}`);
  
  const run = await prisma.schedulerRun.create({
    data: { workerId }
  });

  try {
    const campaignWhere: any = { status: 'active' };
    if (options.campaignId) {
      campaignWhere.id = options.campaignId;
    }

    const campaigns = await prisma.campaign.findMany({
      where: campaignWhere
    });

    for (const campaign of campaigns) {
      // Find the active connected mailbox with credentials for this campaign or fallback
      let mailbox = null;
      if (campaign.senderMailboxes && campaign.senderMailboxes.length > 0) {
        mailbox = await prisma.mailbox.findFirst({
          where: {
            OR: [
              { id: { in: campaign.senderMailboxes } },
              { email: { in: campaign.senderMailboxes } }
            ],
            status: 'CONNECTED',
            isActive: true
          },
          include: { credentials: true }
        });
      }

      if (!mailbox) {
        mailbox = await prisma.mailbox.findFirst({
          where: { status: 'CONNECTED', isActive: true },
          include: { credentials: true }
        });
      }

      if (!mailbox) {
        console.log(`[Scheduler] No connected mailbox found for campaign "${campaign.name}" (${campaign.id})`);
        continue;
      }

      const capacity = await getMailboxCapacity(mailbox.id, !!options.force);
      if (capacity.availableNow <= 0) {
        console.log(`[Scheduler] Mailbox ${mailbox.email} reached daily/hourly limit.`);
        continue;
      }

      // Ensure mailbox isn't rate limited (bypass when force is true)
      if (!options.force && mailbox.nextAvailableSendAt && mailbox.nextAvailableSendAt > new Date()) {
        console.log(`[Scheduler] Mailbox ${mailbox.email} in cooldown until ${mailbox.nextAvailableSendAt.toISOString()}`);
        continue;
      }

      // Find Due Enrollments (bypass step delay when forced/manual)
      const enrollmentWhere: any = {
        campaignId: campaign.id,
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
        enrollmentWhere.AND.push({
          OR: [
            { nextSendAt: { lte: new Date() } },
            { nextSendAt: null }
          ]
        });
      }

      const dueEnrollments = await prisma.enrollment.findMany({
        where: enrollmentWhere,
        take: capacity.availableNow,
        orderBy: { nextSendAt: 'asc' }
      });

      for (const enrollment of dueEnrollments) {
        // 1. Lock Enrollment (clearing expired locks if any)
        const locked = await prisma.enrollment.updateMany({
          where: { 
            id: enrollment.id, 
            OR: [
              { lockedAt: null },
              { lockExpiresAt: { lte: new Date() } }
            ]
          },
          data: {
            lockedAt: new Date(),
            lockedBy: workerId,
            lockExpiresAt: new Date(Date.now() + 10 * 60 * 1000)
          }
        });

        if (locked.count === 0) continue;

        try {
          // 2. Safety Checks
          const stopCheck = await shouldStopBeforeSend(enrollment.id);
          if (stopCheck.stop) {
            await prisma.enrollment.update({
              where: { id: enrollment.id },
              data: { status: stopCheck.reason === 'REPLY_RECEIVED' ? 'replied' : 'completed', stopReason: stopCheck.reason || null }
            });
            emailsSkipped++;
            continue;
          }

          // 3. Load Sequence Step
          const step = await prisma.sequenceStep.findFirst({
            where: { sequenceId: enrollment.sequenceId, stepNumber: enrollment.currentStep }
          });
          if (!step) {
            emailsSkipped++;
            continue;
          }

          const idempotencyKey = `${campaign.id}:${enrollment.id}:${step.id}`;

          // 4. Duplicate Check
          const duplicate = await prisma.emailMessage.findUnique({
            where: { idempotencyKey }
          });
          if (duplicate) {
            emailsSkipped++;
            continue;
          }

          // 5. Load Contact and Render Template using Handlebars
          const contact = await prisma.contact.findUnique({ 
            where: { id: enrollment.contactId },
            include: { emails: true, organization: true }
          });

          const primaryEmail = contact?.emails?.find(e => e.isPrimary)?.email || contact?.emails?.[0]?.email || 'test@example.com';
          const templateSubject = step.subjectTemplate || 'Outreach from TripGain';
          const rawBody = step.bodyTemplate || step.bodyHtmlTemplate || '';

          const templateData = {
            firstName: contact?.firstName || 'there',
            lastName: contact?.lastName || '',
            email: primaryEmail,
            title: contact?.jobTitle || '',
            companyName: contact?.organization?.name || '',
            website: contact?.organization?.domain || '',
            industry: contact?.organization?.industry || '',
            companySize: contact?.organization?.employeeSize || '',
            city: contact?.city || '',
            personalization: contact?.personalizedLine || '',
            personalizedLine: contact?.personalizedLine || '',
            senderName: mailbox.displayName || 'Arup Nirala',
            senderCompany: 'TripGain'
          };

          let renderedSubject = templateSubject;
          let renderedBody = rawBody;

          // Helper to sanitize template before Handlebars compile
          const sanitizeTemplate = (tmpl: string): string => {
            if (!tmpl) return '';
            let cleaned = tmpl
              .replace(/&nbsp;/g, ' ')
              .replace(/&#160;/g, ' ')
              .replace(/&#xA0;/gi, ' ')
              .replace(/\u00A0/g, ' ')
              .replace(/&#125;/g, '}')
              .replace(/&#x7D;/gi, '}')
              .replace(/&#123;/g, '{')
              .replace(/&#x7B;/gi, '{');

            // Strip rogue HTML inside {{...}}
            cleaned = cleaned.replace(/\{\{([^{}]+)\}\}/g, (match, inner) => {
              const innerCleaned = inner.replace(/<[^>]+>/g, '').trim();
              return `{{${innerCleaned}}}`;
            });

            // Auto-balance block tags
            const blocks = ['if', 'unless', 'each', 'with'];
            for (const block of blocks) {
              const openMatches = cleaned.match(new RegExp(`\\{\\{#${block}\\b[^}]*\\}\\}`, 'g')) || [];
              const closeMatches = cleaned.match(new RegExp(`\\{\\{/${block}\\}\\}`, 'g')) || [];
              const diff = openMatches.length - closeMatches.length;
              if (diff > 0) {
                cleaned = cleaned.trimEnd() + '\n' + `{{/${block}}}\n`.repeat(diff).trimEnd();
              }
            }
            return cleaned;
          };

          try {
            const cleanSubject = sanitizeTemplate(templateSubject);
            const hSubject = Handlebars.compile(cleanSubject, { noEscape: true });
            renderedSubject = hSubject(templateData);

            const cleanBody = sanitizeTemplate(rawBody);
            const hBody = Handlebars.compile(cleanBody, { noEscape: true });
            renderedBody = hBody(templateData);
          } catch (renderErr) {
            console.error('[Scheduler] Handlebars render error in scheduler:', renderErr);
          }

          // Clean phantom empty paragraphs from Handlebars blocks
          renderedBody = renderedBody.replace(/<p>\s*<\/p>/gi, '');

          // Generate clean plain text fallback
          const plainText = renderedBody
            .replace(/<p><br\s*\/?><\/p>/gi, '\n\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

          const trackingToken = crypto.randomUUID();

          // 6. Create Message Record (Pending)
          const message = await prisma.emailMessage.create({
            data: {
              idempotencyKey,
              enrollmentId: enrollment.id,
              campaignId: campaign.id,
              sequenceStepId: step.id,
              status: 'pending',
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
            const trackingBaseUrl = process.env.TRACKING_BASE_URL || process.env.BACKEND_URL || 'http://localhost:3001';

            // Open tracking pixel
            const openTrackingPixel = campaign.openTracking !== false
              ? `<img src="${trackingBaseUrl}/t/${trackingToken}" width="1" height="1" style="display:none;width:1px;height:1px;border:0;outline:none;" alt="" />`
              : '';

            // Link click tracking: rewrite external links in renderedBody and store in EmailLink database
            let finalBodyHtml = renderedBody;
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

            // Clean email HTML with proper margins for Gmail/Outlook
            const emailHtml = `
              <!DOCTYPE html>
              <html>
                <head>
                  <meta charset="utf-8">
                  <style>
                    body, div, p { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a1a; }
                    p { margin: 0 0 14px 0; }
                    p:last-child { margin-bottom: 0; }
                    a { color: #2563eb; text-decoration: underline; }
                    ul, ol { margin: 0 0 14px 0; padding-left: 20px; }
                  </style>
                </head>
                <body style="margin: 0; padding: 0;">
                  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a1a;">
                    ${finalBodyHtml}
                    ${openTrackingPixel}
                  </div>
                </body>
              </html>
            `;

            const sendInfo = await transporter.sendMail({
              from: `"${mailbox.displayName || mailbox.email}" <${mailbox.email}>`,
              to: primaryEmail,
              subject: renderedSubject,
              text: plainText,
              html: emailHtml,
              messageId: internetMessageId
            });

            if (sendInfo && sendInfo.messageId) {
              internetMessageId = sendInfo.messageId;
              providerMessageId = sendInfo.messageId;
            }
          }

          // 8. Register Outbound in Unibox thread so prospective replies bind to this thread
          try {
            let conv = await prisma.conversation.findFirst({
              where: { contactId: enrollment.contactId }
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
                senderName: mailbox.displayName || mailbox.email,
                senderEmail: mailbox.email,
                recipientEmails: [primaryEmail],
                subject: renderedSubject,
                bodyText: cleanBodyText,
                bodyHtml: renderedBody,
                isRead: true,
                sentAt: new Date()
              }
            });
          } catch (convErr) {
            console.warn('Could not register campaign email in Unibox:', convErr);
          }

          // 9. Mark Sent in DB
          await prisma.emailMessage.update({
            where: { id: message.id },
            data: {
              status: 'sent',
              sentAt: new Date(),
              providerMessageId,
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

          emailsSent++;

          // 10. Advance Enrollment
          const nextStep = await prisma.sequenceStep.findFirst({
            where: { sequenceId: enrollment.sequenceId, stepNumber: step.stepNumber + 1 }
          });

          const delaySeconds = options.force ? 5 : getRandomDelay();
          const nextSendTime = nextStep ? new Date(Date.now() + nextStep.delayDays * 86400000) : null;
          
          await prisma.enrollment.update({
            where: { id: enrollment.id },
            data: {
              currentStep: nextStep ? nextStep.stepNumber : step.stepNumber,
              status: nextStep ? 'active' : 'completed',
              lastSentAt: new Date(),
              nextSendAt: nextSendTime,
            }
          });

          // 11. Update Mailbox counters
          await prisma.mailbox.update({
            where: { id: mailbox.id },
            data: {
              emailsSentToday: { increment: 1 },
              emailsSentThisHour: { increment: 1 },
              lastSentAt: new Date(),
              nextAvailableSendAt: new Date(Date.now() + delaySeconds * 1000)
            }
          });

        } catch (error) {
          emailsFailed++;
          console.error(`[Scheduler] Error processing enrollment ${enrollment.id}:`, error);
          await prisma.enrollment.update({
            where: { id: enrollment.id },
            data: {
              failureCount: { increment: 1 },
              lastError: 'SENDING_FAILED'
            }
          });
        } finally {
          // Release Lock
          await prisma.enrollment.updateMany({
            where: { id: enrollment.id, lockedBy: workerId },
            data: { lockedAt: null, lockedBy: null, lockExpiresAt: null }
          });
        }
      }
    }

    // Update run record
    await prisma.schedulerRun.update({
      where: { id: run.id },
      data: {
        completedAt: new Date(),
        emailsSent,
        emailsSkipped,
        emailsFailed,
      }
    });
    console.log(`[Scheduler] Finished run. Sent: ${emailsSent}, Skipped: ${emailsSkipped}, Failed: ${emailsFailed}`);
    return { emailsSent, emailsSkipped, emailsFailed };
  } catch (err) {
    console.error(`[Scheduler] Critical Error:`, err);
    return { emailsSent, emailsSkipped, emailsFailed };
  }
}
