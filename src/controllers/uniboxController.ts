import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import nodemailer from 'nodemailer';
import { decrypt } from './mailboxController';

const prisma = new PrismaClient();

export const getConversations = async (req: Request, res: Response): Promise<void> => {
  try {
    const tab = req.query.tab as string | undefined;
    const user = (req as any).user;
    const scope = req.query.scope as string | undefined;
    
    let whereClause: any = {};
    
    if (tab === 'unread') {
      whereClause.unreadCount = { gt: 0 };
    } else if (tab === 'replies') {
      whereClause.messages = { some: { direction: 'INBOUND' } };
    } else if (tab === 'interested') {
      whereClause.interestStatus = 'INTERESTED';
    } else if (tab === 'needs-action') {
      whereClause.status = 'NEEDS_ACTION';
    } else if (tab !== 'all' && tab) {
      whereClause.status = tab;
    }

    // User-level isolation
    if (user && !(user.role === 'ADMIN' && scope === 'all')) {
      const userMailboxes = await prisma.mailbox.findMany({
        where: { userId: user.userId },
        select: { id: true, email: true }
      });
      const userMailboxIds = userMailboxes.map(m => m.id);

      const userCampaigns = await (prisma as any).campaign.findMany({
        where: {
          OR: [
            { userId: user.userId },
            { owner: user.name },
            { owner: user.email }
          ]
        },
        select: { id: true }
      });
      const userCampaignIds = userCampaigns.map((c: any) => c.id);

      whereClause.OR = [
        { mailboxId: { in: userMailboxIds } },
        { campaignId: { in: userCampaignIds } },
        { assignedTo: user.userId },
        { assignedTo: user.email }
      ];
    }

    const conversations = await prisma.conversation.findMany({
      where: whereClause,
      include: {
        contact: {
          include: { emails: true }
        },
        campaign: true,
        organization: true
      },
      orderBy: { latestMessageAt: 'desc' }
    });

    res.status(200).json(conversations);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
};

export const getConversationById = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        contact: {
          include: { emails: true }
        },
        campaign: true,
        organization: true,
        enrollment: true,
        sequence: true,
        messages: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    res.status(200).json(conversation);
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
};

export const replyToConversation = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { bodyText, bodyHtml } = req.body;

    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: { contact: { include: { emails: true } } }
    });

    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const primaryEmail = conversation.contact?.emails?.find((e: any) => e.isPrimary)?.email || conversation.contact?.emails?.[0]?.email || '';

    // Find the active connected mailbox for this user (or fallback to active mailbox)
    const user = (req as any).user;
    let mailbox = null;
    if (user) {
      mailbox = await prisma.mailbox.findFirst({
        where: { userId: user.userId, status: 'CONNECTED', isActive: true },
        include: { credentials: true }
      });
    }
    if (!mailbox) {
      mailbox = await prisma.mailbox.findFirst({
        where: { status: 'CONNECTED', isActive: true },
        include: { credentials: true }
      });
    }

    let sentViaSmtp = false;
    let smtpError: string | null = null;

    if (mailbox && mailbox.credentials && primaryEmail) {
      try {
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

        await transporter.sendMail({
          from: `"${mailbox.displayName || mailbox.email}" <${mailbox.email}>`,
          to: primaryEmail,
          subject: `Re: ${conversation.subject || 'Follow up'}`,
          text: bodyText,
          html: bodyHtml || `<div style="font-family: sans-serif; white-space: pre-wrap; line-height: 1.6;">${bodyText}</div>`
        });

        sentViaSmtp = true;
        await prisma.mailbox.update({
          where: { id: mailbox.id },
          data: { emailsSentToday: { increment: 1 }, lastSentAt: new Date() }
        });
      } catch (err: any) {
        console.error('SMTP sending error from Unibox reply:', err);
        smtpError = err?.message || 'SMTP delivery failed';
      }
    }

    // Create the manual reply message
    const message = await prisma.conversationMessage.create({
      data: {
        conversationId: id,
        direction: 'OUTBOUND',
        messageType: 'EMAIL',
        senderName: mailbox?.displayName || 'Arup Nirala',
        senderEmail: mailbox?.email || 'arup.nirala@tripgainapp.com', 
        recipientEmails: [primaryEmail],
        subject: `Re: ${conversation.subject || 'Follow up'}`,
        bodyText,
        bodyHtml,
        isRead: true,
        sentAt: new Date()
      }
    });

    // Update conversation status
    const updatedConv = await prisma.conversation.update({
      where: { id },
      data: {
        status: 'OPEN', // No longer NEEDS_ACTION
        latestMessageAt: new Date(),
        latestMessagePreview: bodyText?.substring(0, 50) + '...',
        latestMessageDirection: 'OUTBOUND',
        lastOutboundAt: new Date(),
        replyRequired: false
      }
    });

    res.status(200).json({ 
      success: true,
      message: sentViaSmtp ? `Reply sent directly to ${primaryEmail} via ${mailbox?.email}!` : 'Reply recorded', 
      sentViaSmtp,
      smtpError,
      data: message, 
      conversation: updatedConv 
    });
  } catch (error) {
    console.error('Error replying to conversation:', error);
    res.status(500).json({ error: 'Failed to send reply' });
  }
};

export const performConversationAction = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const action = req.params.action as string;
    
    let updateData: any = {};

    switch (action) {
      case 'mark-interested':
        updateData.interestStatus = 'INTERESTED';
        break;
      case 'mark-not-interested':
        updateData.interestStatus = 'NOT_INTERESTED';
        updateData.status = 'CLOSED';
        break;
      case 'archive':
        updateData.status = 'ARCHIVED';
        updateData.archivedAt = new Date();
        break;
      case 'read':
        updateData.unreadCount = 0;
        updateData.lastReadAt = new Date();
        break;
      default:
        res.status(400).json({ error: 'Invalid action' });
        return;
    }

    const updated = await prisma.conversation.update({
      where: { id },
      data: updateData
    });

    await prisma.conversationAction.create({
      data: {
        conversationId: id,
        actionType: action?.toUpperCase() || 'UNKNOWN',
        performedBy: 'System',
      }
    });

    res.status(200).json(updated);
  } catch (error) {
    console.error(`Error performing action ${req.params.action}:`, error);
    res.status(500).json({ error: 'Failed to perform action' });
  }
};

export const simulateLeadReply = async (req: Request, res: Response): Promise<void> => {
  try {
    const { contactEmail, leadName, companyName, messageText } = req.body;
    
    // Find or create a contact to simulate the reply from
    let contact: any = await prisma.contact.findFirst({
      where: contactEmail ? { emails: { some: { email: contactEmail } } } : {},
      include: { emails: true, organization: true }
    });

    if (!contact) {
      const workspace = await prisma.workspace.findFirst();
      const name = leadName || 'Rahul Sharma';
      const email = contactEmail || 'rahul.sharma@acmetech.com';
      const company = companyName || 'Acme Technologies';

      let org = await prisma.organization.findFirst({ where: { name: company } });
      if (!org && workspace) {
        org = await prisma.organization.create({
          data: {
            workspaceId: workspace.id,
            name: company,
            domain: 'acmetech.com',
            industry: 'Information Technology',
            employeeSize: '50-100'
          }
        });
      }

      contact = await prisma.contact.create({
        data: {
          workspaceId: workspace?.id || '',
          organizationId: org?.id || null,
          firstName: name.split(' ')[0] || 'Rahul',
          lastName: name.split(' ')[1] || 'Sharma',
          fullName: name,
          jobTitle: 'VP of Operations',
          emails: {
            create: [{ email, isPrimary: true, normalizedEmail: email.toLowerCase() }]
          }
        },
        include: { emails: true, organization: true }
      });
    }

    const defaultText = messageText || `Hi Arup,\n\nThanks for reaching out! We are currently looking for an all-in-one corporate travel and expense management tool for our 65-person team.\n\nCould you share your pricing plans and whether TripGain integrates with corporate cards?\n\nBest regards,\n${contact.fullName || 'Rahul Sharma'}`;

    // Create Conversation
    const conversation = await prisma.conversation.create({
      data: {
        contactId: contact.id,
        organizationId: contact.organizationId,
        subject: "Re: Simplifying business travel for your team",
        status: "NEEDS_ACTION",
        priority: "HIGH",
        unreadCount: 1,
        replyRequired: true,
        interestStatus: "INTERESTED",
        latestMessageAt: new Date(),
        latestMessagePreview: defaultText.slice(0, 60) + "...",
        latestMessageDirection: "INBOUND",
        lastInboundAt: new Date(),
        messages: {
          create: {
            direction: "INBOUND",
            messageType: "EMAIL",
            senderName: contact.fullName || "Rahul Sharma",
            senderEmail: contact.emails?.[0]?.email || "rahul.sharma@acmetech.com",
            subject: "Re: Simplifying business travel for your team",
            bodyText: defaultText,
            isRead: false,
            receivedAt: new Date()
          }
        }
      },
      include: {
        contact: true,
        organization: true,
        messages: true
      }
    });

    res.status(201).json({
      success: true,
      message: 'Simulated incoming reply created in Unibox',
      conversation
    });
  } catch (error: any) {
    console.error('Error simulating reply:', error);
    res.status(500).json({ error: error?.message || 'Failed to simulate reply' });
  }
};

export const syncReplies = async (req: Request, res: Response): Promise<void> => {
  try {
    const { mailboxId } = req.body || {};
    const { syncMailboxReplies } = await import('../services/imapSyncService');
    const result = await syncMailboxReplies(mailboxId);
    
    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: any) {
    console.error('Error in syncReplies endpoint:', error);
    res.status(500).json({ success: false, error: error?.message || 'Failed to sync replies' });
  }
};
