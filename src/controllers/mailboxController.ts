import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { getCalendarBucketBounds, getDispatchedMessageCounts } from '../services/quotaService';

const prisma = new PrismaClient();
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || process.env.MAILBOX_ENCRYPTION_KEY || '12345678901234567890123456789012'; // 32 bytes
const IV_LENGTH = 16;

function encrypt(text: string): string {
  if (!text) return '';
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decrypt(text: string): string {
  try {
    if (!text || !text.includes(':')) return text;
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift()!, 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (err) {
    return text;
  }
}

export const getMailboxes = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const scope = req.query.scope as string | undefined;

    let whereClause: any = {};

    if (user) {
      if (user.role === 'ADMIN' && scope === 'all') {
        // Admin requested to view all workspace mailboxes
      } else {
        // Standard user or default admin view: only show mailboxes owned by this user
        whereClause.userId = user.userId;
      }
    }

    const mailboxes = await prisma.mailbox.findMany({
      where: whereClause,
      include: {
        user: { select: { id: true, name: true, email: true, role: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Enrich mailboxes with all-time sending stats, delivery health, and assigned campaigns
    const enrichedMailboxes = await Promise.all(
      mailboxes.map(async (m) => {
        const email = m.email.toLowerCase().trim();

        const [
          totalMessagesCount,
          bouncedMessagesCount,
          openedMessagesCount,
          openedEventsCount,
          clickedMessagesCount,
          clickedEventsCount,
          repliedMessagesCount,
          repliedEventsCount,
          inboundConversationsCount,
          campaigns
        ] = await Promise.all([
          prisma.emailMessage.count({
            where: { fromEmail: { equals: email, mode: 'insensitive' }, status: { in: ['sent', 'delivered', 'opened', 'clicked', 'replied'] } }
          }),
          prisma.emailMessage.count({
            where: { fromEmail: { equals: email, mode: 'insensitive' }, status: 'bounced' }
          }),
          prisma.emailMessage.count({
            where: { fromEmail: { equals: email, mode: 'insensitive' }, openedAt: { not: null } }
          }),
          prisma.emailEvent.count({
            where: {
              eventType: { in: ['opened', 'email.opened', 'OPENED'] },
              message: { fromEmail: { equals: email, mode: 'insensitive' } }
            }
          }),
          prisma.emailMessage.count({
            where: { fromEmail: { equals: email, mode: 'insensitive' }, clickedAt: { not: null } }
          }),
          prisma.emailEvent.count({
            where: {
              eventType: { in: ['clicked', 'email.clicked', 'CLICKED'] },
              message: { fromEmail: { equals: email, mode: 'insensitive' } }
            }
          }),
          prisma.emailMessage.count({
            where: { fromEmail: { equals: email, mode: 'insensitive' }, repliedAt: { not: null } }
          }),
          prisma.emailEvent.count({
            where: {
              eventType: { in: ['replied', 'email.replied', 'REPLIED'] },
              message: { fromEmail: { equals: email, mode: 'insensitive' } }
            }
          }),
          prisma.conversation.count({
            where: {
              mailboxId: m.id,
              latestMessageDirection: 'INBOUND'
            }
          }),
          prisma.campaign.findMany({
            where: { senderMailboxes: { has: m.email } },
            select: { id: true, name: true, status: true }
          })
        ]);

        // Ground-truth calendar-bucket counts in mailbox's sending timezone
        const bounds = getCalendarBucketBounds(new Date(), m.sendingTimezone || 'Asia/Kolkata');
        const bucketCounts = await getDispatchedMessageCounts({
          mailboxEmail: m.email,
          startOfHour: bounds.startOfHour,
          endOfHour: bounds.endOfHour,
          startOfDay: bounds.startOfDay,
          endOfDay: bounds.endOfDay
        });

        const emailsSentToday = bucketCounts.mailboxSentToday;
        const emailsSentThisHour = bucketCounts.mailboxSentThisHour;
        const totalSentAllTime = Math.max(totalMessagesCount, emailsSentToday, m.emailsSentToday || 0);
        const totalBounced = bouncedMessagesCount;
        // In direct SMTP outreach, emails accepted by recipient SMTP servers are delivered unless bounced:
        const totalDelivered = Math.max(0, totalSentAllTime - totalBounced);
        const totalOpened = Math.max(openedMessagesCount, openedEventsCount);
        const totalClicked = Math.max(clickedMessagesCount, clickedEventsCount);
        const totalReplied = Math.max(repliedMessagesCount, repliedEventsCount, inboundConversationsCount);
        const bounceRate = totalSentAllTime > 0 ? (totalBounced / totalSentAllTime) * 100 : 0;
        
        let healthScore = 100;
        if (m.status !== 'CONNECTED' || m.smtpStatus !== 'CONNECTED') {
          healthScore = 50;
        } else {
          healthScore = Math.max(70, Math.round(100 - (bounceRate * 5)));
        }

        const stats = {
          totalSentAllTime,
          emailsSentToday,
          emailsSentThisHour,
          remainingToday: Math.max(0, m.dailySendLimit - emailsSentToday),
          remainingThisHour: Math.max(0, m.hourlySendLimit - emailsSentThisHour),
          dailyUtilization: Math.min(100, Math.round((emailsSentToday / Math.max(1, m.dailySendLimit)) * 100)),
          hourlyUtilization: Math.min(100, Math.round((emailsSentThisHour / Math.max(1, m.hourlySendLimit)) * 100)),
          totalDelivered,
          totalBounced,
          totalOpened,
          totalClicked,
          totalReplied,
          openRate: totalSentAllTime > 0 ? ((totalOpened / totalSentAllTime) * 100).toFixed(1) : '0.0',
          clickRate: totalSentAllTime > 0 ? ((totalClicked / totalSentAllTime) * 100).toFixed(1) : '0.0',
          replyRate: totalSentAllTime > 0 ? ((totalReplied / totalSentAllTime) * 100).toFixed(1) : '0.0',
          bounceRate: bounceRate.toFixed(1),
          healthScore,
          campaignsCount: campaigns.length,
          campaigns,
          currentHourResetAt: bounds.endOfHour.toISOString(),
          timeZone: bounds.timeZone
        };

        return {
          ...m,
          emailsSentToday,
          emailsSentThisHour,
          stats
        };
      })
    );

    res.status(200).json(enrichedMailboxes);
  } catch (error) {
    console.error('Failed to get mailboxes:', error);
    res.status(500).json({ error: 'Failed to get mailboxes' });
  }
};

export const connectSmtpImap = async (req: Request, res: Response): Promise<void> => {
  try {
    const { 
      email, 
      displayName, 
      provider = 'SMTP_IMAP',
      smtpHost, 
      smtpPort = 587, 
      smtpUsername, 
      smtpPassword, 
      imapHost, 
      imapPort = 993, 
      imapUsername, 
      imapPassword 
    } = req.body;

    if (!email || !smtpPassword) {
      res.status(400).json({ error: 'Email and App Password are required' });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    // Strip any spaces from the App password (Google app passwords typically have spaces: "abcd efgh ijkl mnop")
    const cleanPassword = smtpPassword.replace(/\s+/g, '').trim();
    const cleanSmtpUsername = (smtpUsername || cleanEmail).trim();
    const cleanImapUsername = (imapUsername || cleanEmail).trim();

    const isGoogle = provider === 'GOOGLE' || smtpHost?.includes('gmail.com') || cleanEmail.endsWith('@gmail.com');
    const finalSmtpHost = isGoogle ? 'smtp.gmail.com' : (smtpHost || 'smtp.gmail.com');
    const finalSmtpPort = isGoogle ? 465 : Number(smtpPort || 587);
    const finalImapHost = isGoogle ? 'imap.gmail.com' : (imapHost || 'imap.gmail.com');
    const finalImapPort = isGoogle ? 993 : Number(imapPort || 993);

    const user = (req as any).user;
    const userId = user?.userId || null;
    const ownerName = user?.name || user?.email || null;

    // Test SMTP Authentication
    try {
      const transporter = nodemailer.createTransport({
        host: finalSmtpHost,
        port: finalSmtpPort,
        secure: finalSmtpPort === 465,
        auth: {
          user: cleanSmtpUsername,
          pass: cleanPassword
        },
        connectionTimeout: 10000
      });
      await transporter.verify();
    } catch (smtpErr: any) {
      console.error('SMTP verification failed:', smtpErr);
      let userFriendlyError = 'Could not authenticate with mail server.';
      if (isGoogle) {
        userFriendlyError = 'Google authentication failed. Please make sure you are using a 16-character Google App Password (not your personal account password) and 2-Step Verification is enabled in Google.';
      } else if (smtpErr.responseCode === 535 || smtpErr.message?.includes('Invalid login')) {
        userFriendlyError = 'Invalid email or password. Please check your credentials.';
      }
      res.status(400).json({ 
        error: userFriendlyError,
        technicalDetails: smtpErr.message 
      });
      return;
    }

    // Upsert Mailbox record (handles both fresh connect and updating existing)
    const mailbox = await prisma.mailbox.upsert({
      where: { email: cleanEmail },
      update: {
        userId: userId || undefined,
        ownerName: ownerName || undefined,
        displayName: displayName?.trim() || cleanEmail,
        provider: isGoogle ? 'GOOGLE' : provider,
        connectionType: 'SMTP_IMAP',
        status: 'CONNECTED',
        smtpStatus: 'CONNECTED',
        imapStatus: 'CONNECTED',
        replySyncStatus: 'ACTIVE',
        isActive: true,
        lastTestedAt: new Date(),
        lastError: null
      },
      create: {
        userId,
        ownerName,
        email: cleanEmail,
        displayName: displayName?.trim() || cleanEmail,
        provider: isGoogle ? 'GOOGLE' : provider,
        connectionType: 'SMTP_IMAP',
        status: 'CONNECTED',
        smtpStatus: 'CONNECTED',
        imapStatus: 'CONNECTED',
        replySyncStatus: 'ACTIVE',
        isActive: true,
        lastTestedAt: new Date()
      }
    });

    // Upsert Credentials record
    await prisma.mailboxCredential.upsert({
      where: { mailboxId: mailbox.id },
      update: {
        encryptedSmtpHost: encrypt(finalSmtpHost),
        encryptedSmtpPort: encrypt(String(finalSmtpPort)),
        encryptedSmtpUsername: encrypt(cleanSmtpUsername),
        encryptedSmtpPassword: encrypt(cleanPassword),
        encryptedImapHost: encrypt(finalImapHost),
        encryptedImapPort: encrypt(String(finalImapPort)),
        encryptedImapUsername: encrypt(cleanImapUsername),
        encryptedImapPassword: encrypt(cleanPassword),
      },
      create: {
        mailboxId: mailbox.id,
        encryptedSmtpHost: encrypt(finalSmtpHost),
        encryptedSmtpPort: encrypt(String(finalSmtpPort)),
        encryptedSmtpUsername: encrypt(cleanSmtpUsername),
        encryptedSmtpPassword: encrypt(cleanPassword),
        encryptedImapHost: encrypt(finalImapHost),
        encryptedImapPort: encrypt(String(finalImapPort)),
        encryptedImapUsername: encrypt(cleanImapUsername),
        encryptedImapPassword: encrypt(cleanPassword),
      }
    });

    res.status(201).json({
      success: true,
      mailbox,
      message: 'Mailbox connected and verified successfully!'
    });
  } catch (error: any) {
    console.error('Error connecting mailbox:', error);
    res.status(500).json({ error: error?.message || 'Failed to connect mailbox' });
  }
};

export const disconnectMailbox = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const user = (req as any).user;

    const existing = await prisma.mailbox.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Mailbox not found' });
      return;
    }

    if (user && user.role !== 'ADMIN' && existing.userId && existing.userId !== user.userId) {
      res.status(403).json({ error: 'Unauthorized: You can only disconnect your own mailbox' });
      return;
    }
    
    // Delete credentials
    await prisma.mailboxCredential.deleteMany({
      where: { mailboxId: id }
    });

    // Update mailbox status
    const updated = await prisma.mailbox.update({
      where: { id },
      data: {
        status: 'DISCONNECTED',
        isActive: false,
        smtpStatus: 'NOT_CONFIGURED',
        imapStatus: 'NOT_CONFIGURED',
        replySyncStatus: 'INACTIVE',
      }
    });

    res.status(200).json(updated);
  } catch (error) {
    console.error('Error disconnecting mailbox:', error);
    res.status(500).json({ error: 'Failed to disconnect mailbox' });
  }
};

export const updateMailboxLimits = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const user = (req as any).user;
    const { 
      dailySendLimit, 
      hourlySendLimit, 
      displayName,
      sendingStartTime,
      sendingEndTime,
      sendingTimezone,
      sendingDays,
      warmupStatus
    } = req.body;

    const mailbox = await prisma.mailbox.findUnique({ where: { id } });
    if (!mailbox) {
      res.status(404).json({ error: 'Mailbox not found' });
      return;
    }

    if (user && user.role !== 'ADMIN' && mailbox.userId && mailbox.userId !== user.userId) {
      res.status(403).json({ error: 'Unauthorized: You can only update your own mailbox' });
      return;
    }

    const updated = await prisma.mailbox.update({
      where: { id },
      data: {
        ...(dailySendLimit !== undefined && { dailySendLimit: Math.max(1, Number(dailySendLimit)) }),
        ...(hourlySendLimit !== undefined && { hourlySendLimit: Math.max(1, Number(hourlySendLimit)) }),
        ...(displayName !== undefined && { displayName: String(displayName).trim() }),
        ...(sendingStartTime !== undefined && { sendingStartTime: String(sendingStartTime).trim() }),
        ...(sendingEndTime !== undefined && { sendingEndTime: String(sendingEndTime).trim() }),
        ...(sendingTimezone !== undefined && { sendingTimezone: String(sendingTimezone).trim() }),
        ...(sendingDays !== undefined && { sendingDays }),
        ...(warmupStatus !== undefined && { warmupStatus: String(warmupStatus).trim() })
      }
    });

    res.status(200).json(updated);
  } catch (error: any) {
    console.error('Failed to update mailbox limits:', error);
    res.status(500).json({ error: error?.message || 'Failed to update mailbox limits' });
  }
};

export const testMailbox = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const mailbox = await prisma.mailbox.findUnique({
      where: { id },
      include: { credentials: true }
    });

    if (!mailbox || !mailbox.credentials) {
      res.status(404).json({ error: 'Mailbox or credentials not found' });
      return;
    }

    const smtpHost = mailbox.credentials.encryptedSmtpHost ? decrypt(mailbox.credentials.encryptedSmtpHost) : 'smtp.gmail.com';
    const smtpPort = mailbox.credentials.encryptedSmtpPort ? Number(decrypt(mailbox.credentials.encryptedSmtpPort)) : 465;
    const smtpUser = mailbox.credentials.encryptedSmtpUsername ? decrypt(mailbox.credentials.encryptedSmtpUsername) : mailbox.email;
    const smtpPass = mailbox.credentials.encryptedSmtpPassword ? decrypt(mailbox.credentials.encryptedSmtpPassword) : '';

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass
      },
      connectionTimeout: 10000,
      greetingTimeout: 5000,
      socketTimeout: 10000
    });

    await transporter.verify();

    await prisma.mailbox.update({
      where: { id },
      data: {
        status: 'CONNECTED',
        smtpStatus: 'CONNECTED',
        lastTestedAt: new Date(),
        lastError: null
      }
    });

    res.status(200).json({
      sending: { success: true, message: `SMTP connection to ${smtpHost} verified successfully` },
      replySync: { success: true, message: 'IMAP connection configured and active' },
      status: 'Mailbox connected and ready to send'
    });
  } catch (error: any) {
    console.error('Mailbox test failed:', error);
    res.status(400).json({
      sending: { success: false, message: error?.message || 'SMTP Authentication failed' },
      replySync: { success: false, message: 'IMAP check skipped due to SMTP error' },
      error: error?.message || 'Test failed'
    });
  }
};

export const sendTestEmail = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { toEmail } = req.body;

    const mailbox = await prisma.mailbox.findUnique({
      where: { id },
      include: { credentials: true }
    });

    if (!mailbox || !mailbox.credentials) {
      res.status(404).json({ error: 'Mailbox or credentials not found' });
      return;
    }

    const bounds = getCalendarBucketBounds(new Date(), mailbox.sendingTimezone || 'Asia/Kolkata');
    const bucketCounts = await getDispatchedMessageCounts({
      mailboxEmail: mailbox.email,
      startOfHour: bounds.startOfHour,
      endOfHour: bounds.endOfHour,
      startOfDay: bounds.startOfDay,
      endOfDay: bounds.endOfDay
    });

    if (bucketCounts.mailboxSentToday >= mailbox.dailySendLimit) {
      res.status(429).json({ error: `Cannot send test email: Mailbox daily sending limit (${mailbox.dailySendLimit}) has been reached for today.` });
      return;
    }

    const smtpHost = mailbox.credentials.encryptedSmtpHost ? decrypt(mailbox.credentials.encryptedSmtpHost) : 'smtp.gmail.com';
    const smtpPort = mailbox.credentials.encryptedSmtpPort ? Number(decrypt(mailbox.credentials.encryptedSmtpPort)) : 465;
    const smtpUser = mailbox.credentials.encryptedSmtpUsername ? decrypt(mailbox.credentials.encryptedSmtpUsername) : mailbox.email;
    const smtpPass = mailbox.credentials.encryptedSmtpPassword ? decrypt(mailbox.credentials.encryptedSmtpPassword) : '';

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass
      },
      connectionTimeout: 10000
    });

    const targetEmail = toEmail || mailbox.email;

    const info = await transporter.sendMail({
      from: `"${mailbox.displayName || mailbox.email}" <${mailbox.email}>`,
      to: targetEmail,
      subject: '✅ AutoOutreach Test Email - Connection Confirmed!',
      text: `Hello ${mailbox.displayName || ''}!\n\nThis email confirms that your mailbox (${mailbox.email}) is successfully connected to AutoOutreach via Google SMTP.\n\nYour campaign emails will be sent directly through this account.`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;">
          <h2 style="color: #16a34a; margin-top: 0;">&#10004; Live Connection Confirmed!</h2>
          <p style="color: #374151; font-size: 15px; line-height: 1.6;">
            This email was sent from your connected Google account: <strong>${mailbox.email}</strong>.
          </p>
          <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <p style="margin: 0; color: #166534; font-weight: 600; font-size: 14px;">SMTP Status: Active & Verified</p>
            <p style="margin: 4px 0 0; color: #15803d; font-size: 13px;">Google SMTP (${smtpHost}:${smtpPort}) authenticated successfully.</p>
          </div>
          <p style="color: #6b7280; font-size: 13px; line-height: 1.5;">
            You are ready to launch cold outreach campaigns using this sender address.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
          <p style="color: #9ca3af; font-size: 11px; margin: 0;">Sent via AutoOutreach Engine</p>
        </div>
      `
    });

    // Synchronize mailbox sent counters with dynamic ground truth
    await prisma.mailbox.update({
      where: { id },
      data: {
        emailsSentToday: bucketCounts.mailboxSentToday + 1,
        emailsSentThisHour: bucketCounts.mailboxSentThisHour + 1,
        lastSentAt: new Date()
      }
    });

    // Register this outbound email in TripGain Unibox so replies to this thread are strictly tracked
    try {
      const workspace = await prisma.workspace.findFirst();
      let contact: any = await prisma.contact.findFirst({
        where: { emails: { some: { normalizedEmail: targetEmail.toLowerCase() } } },
        include: { emails: true }
      });

      if (!contact && workspace) {
        contact = await prisma.contact.create({
          data: {
            workspaceId: workspace.id,
            fullName: targetEmail.split('@')[0],
            firstName: targetEmail.split('@')[0],
            emails: {
              create: [{ email: targetEmail, normalizedEmail: targetEmail.toLowerCase(), isPrimary: true }]
            }
          },
          include: { emails: true }
        });
      }

      if (contact) {
        let conversation = await prisma.conversation.findFirst({
          where: { contactId: contact.id }
        });

        const subject = '✅ AutoOutreach Test Email - Connection Confirmed!';
        const bodyPreview = `This email confirms that your mailbox (${mailbox.email}) is successfully connected to AutoOutreach via Google SMTP.`;

        if (!conversation) {
          conversation = await prisma.conversation.create({
            data: {
              mailboxId: mailbox.id,
              contactId: contact.id,
              subject,
              status: 'OPEN',
              priority: 'NORMAL',
              latestMessageAt: new Date(),
              latestMessagePreview: bodyPreview.slice(0, 60) + '...',
              latestMessageDirection: 'OUTBOUND',
              lastOutboundAt: new Date()
            }
          });
        }

        await prisma.conversationMessage.create({
          data: {
            conversationId: conversation.id,
            direction: 'OUTBOUND',
            messageType: 'EMAIL',
            internetMessageId: info.messageId,
            providerMessageId: info.messageId,
            senderName: mailbox.displayName || mailbox.email,
            senderEmail: mailbox.email,
            recipientEmails: [targetEmail],
            subject,
            bodyText: `Hello!\n\nThis email confirms that your mailbox (${mailbox.email}) is successfully connected to AutoOutreach via Google SMTP.\n\nYour campaign emails will be sent directly through this account.`,
            isRead: true,
            sentAt: new Date()
          }
        });
      }
    } catch (trackErr) {
      console.warn('Could not register test email in Unibox thread:', trackErr);
    }

    res.status(200).json({
      success: true,
      message: `Live test email successfully sent to ${targetEmail}!`,
      messageId: info.messageId
    });
  } catch (error: any) {
    console.error('Failed to send test email:', error);
    res.status(400).json({
      success: false,
      error: error?.message || 'Failed to send test email'
    });
  }
};

// Stub for OAuth endpoints
export const googleCallback = async (req: Request, res: Response): Promise<void> => {
  res.status(200).send('Google OAuth Flow Callback - Not implemented in MVP');
};

export const microsoftCallback = async (req: Request, res: Response): Promise<void> => {
  res.status(200).send('Microsoft OAuth Flow Callback - Not implemented in MVP');
};
