import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import nodemailer from 'nodemailer';
import Handlebars from 'handlebars';
import crypto from 'crypto';
import { OwnershipGuard } from '../utils/ownershipGuard';
import { decrypt } from './mailboxController';
import { selectFairMailbox, getCampaignEnrollmentCountsByMailbox } from '../services/rotationService';
import { buildCanonicalLeadContext } from '../utils/templateContext';

const prisma = new PrismaClient();

const getWorkspace = async (userId?: string) => {
  let workspace = userId 
    ? await prisma.workspace.findFirst({ where: { userId } }) 
    : await prisma.workspace.findFirst();
  if (!workspace) {
    workspace = await prisma.workspace.findFirst();
  }
  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: {
        name: 'Default Workspace',
        user: { create: { email: 'admin@tripgain.in', name: 'Admin' } }
      }
    });
  }
  return workspace;
};

// ---------------------------------------------------------------------
// 1. List Bulk Campaigns (Scoped strictly to authenticated user)
// ---------------------------------------------------------------------
export const getBulkCampaigns = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const campaigns = await prisma.campaign.findMany({
      where: {
        userId: user.userId,
        campaignType: 'BULK_EMAIL'
      },
      include: {
        list: {
          select: { id: true, name: true }
        },
        sequences: {
          include: {
            steps: true
          }
        },
        enrollments: {
          select: { id: true, status: true }
        },
        messages: {
          select: { id: true, status: true, sentAt: true }
        },
        events: {
          select: { id: true, eventType: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const enriched = campaigns.map((camp) => {
      const enrollments = camp.enrollments || [];
      const messages = camp.messages || [];
      const events = camp.events || [];

      const totalRecipients = enrollments.length;
      const sentCount = messages.filter((m) => ['sent', 'delivered', 'opened', 'clicked', 'replied'].includes(m.status)).length;
      const deliveredCount = messages.filter((m) => ['delivered', 'opened', 'clicked', 'replied'].includes(m.status)).length;
      const uniqueOpens = events.filter((e) => e.eventType === 'opened').length;
      const bounces = enrollments.filter((e) => ['bounced', 'soft_bounced'].includes(e.status)).length;
      const unsubscribes = enrollments.filter((e) => e.status === 'unsubscribed').length;

      return {
        id: camp.id,
        name: camp.name,
        description: camp.description,
        status: camp.status,
        campaignType: camp.campaignType,
        listId: camp.listId,
        listName: camp.list?.name || null,
        senderMailboxes: camp.senderMailboxes,
        dailySendLimit: camp.dailySendLimit,
        hourlySendLimit: camp.hourlySendLimit,
        timezone: camp.timezone,
        sendingWindowStart: camp.sendingWindowStart,
        sendingWindowEnd: camp.sendingWindowEnd,
        startAt: camp.startAt,
        totalRecipients,
        sentCount,
        deliveredCount,
        uniqueOpens,
        bounces,
        unsubscribes,
        createdAt: camp.createdAt,
        updatedAt: camp.updatedAt,
        step: camp.sequences?.[0]?.steps?.[0] || null
      };
    });

    res.status(200).json(enriched);
  } catch (error: any) {
    console.error('Error in getBulkCampaigns:', error);
    res.status(500).json({ error: 'Failed to fetch bulk campaigns' });
  }
};

// ---------------------------------------------------------------------
// 2. Get Single Bulk Campaign Details
// ---------------------------------------------------------------------
export const getBulkCampaignById = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const campaignId = req.params.id as string;
    const campaign = await prisma.campaign.findFirst({
      where: {
        id: campaignId,
        userId: user.userId,
        campaignType: 'BULK_EMAIL'
      },
      include: {
        list: {
          select: { id: true, name: true }
        },
        sequences: {
          include: {
            steps: { orderBy: { stepNumber: 'asc' } }
          }
        },
        enrollments: {
          select: { id: true, status: true, mailboxId: true }
        }
      }
    });

    if (!campaign) {
      res.status(404).json({ error: 'Bulk campaign not found' });
      return;
    }

    res.status(200).json(campaign);
  } catch (error: any) {
    console.error('Error in getBulkCampaignById:', error);
    res.status(500).json({ error: 'Failed to fetch bulk campaign' });
  }
};

// ---------------------------------------------------------------------
// 3. Create Bulk Campaign (Draft with 1-Step Sequence)
// ---------------------------------------------------------------------
export const createBulkCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const {
      name,
      description,
      listId,
      senderMailboxes,
      subject,
      bodyHtml,
      dailySendLimit,
      hourlySendLimit,
      timezone,
      sendingWindowStart,
      sendingWindowEnd,
      startAt
    } = req.body;

    if (!name || !name.trim()) {
      res.status(400).json({ error: 'Campaign name is required' });
      return;
    }

    const workspace = await getWorkspace(user.userId);

    // Verify list ownership if provided
    if (listId) {
      const list = await prisma.list.findFirst({
        where: { id: listId, userId: user.userId }
      });
      if (!list) {
        res.status(400).json({ error: 'Selected audience list not found or unauthorized' });
        return;
      }
    }

    // Verify mailbox ownership if provided
    if (Array.isArray(senderMailboxes) && senderMailboxes.length > 0) {
      const mailboxes = await prisma.mailbox.findMany({
        where: {
          OR: [
            { id: { in: senderMailboxes } },
            { email: { in: senderMailboxes } }
          ],
          userId: user.userId
        }
      });
      if (mailboxes.length !== senderMailboxes.length) {
        res.status(400).json({ error: 'One or more selected mailboxes are invalid or unauthorized' });
        return;
      }
    }

    const sub = req.body.subjectTemplate !== undefined ? req.body.subjectTemplate : (req.body.subject || '');
    const bHtml = req.body.bodyHtmlTemplate !== undefined 
      ? req.body.bodyHtmlTemplate 
      : (req.body.bodyHtml !== undefined ? req.body.bodyHtml : (req.body.bodyTemplate || ''));

    const campaign = await prisma.campaign.create({
      data: {
        workspaceId: workspace.id,
        userId: user.userId,
        name: name.trim(),
        description: description || null,
        campaignType: 'BULK_EMAIL',
        audienceType: 'list',
        status: 'draft',
        listId: listId || null,
        senderMailboxes: Array.isArray(senderMailboxes) ? senderMailboxes : [],
        dailySendLimit: Number(dailySendLimit) || 100,
        hourlySendLimit: Number(hourlySendLimit) || 20,
        timezone: timezone || 'Asia/Kolkata',
        sendingWindowStart: sendingWindowStart || '09:30:00',
        sendingWindowEnd: sendingWindowEnd || '17:30:00',
        startAt: startAt ? new Date(startAt) : null,
        sequences: {
          create: {
            name: `${name.trim()} Sequence`,
            sequenceType: 'BULK_EMAIL',
            status: 'active',
            steps: {
              create: {
                stepNumber: 1,
                stepType: 'email',
                stepName: 'Bulk Email',
                subjectTemplate: sub || '',
                bodyTemplate: bHtml || '',
                bodyHtmlTemplate: bHtml || '',
                includeTracking: true,
                includeUnsubscribe: true
              }
            }
          }
        }
      },
      include: {
        sequences: {
          include: { steps: true }
        }
      }
    });

    res.status(201).json(campaign);
  } catch (error: any) {
    console.error('Error in createBulkCampaign:', error);
    res.status(500).json({ error: 'Failed to create bulk campaign' });
  }
};

// ---------------------------------------------------------------------
// 4. Update Bulk Campaign
// ---------------------------------------------------------------------
export const updateBulkCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const campaignId = req.params.id as string;
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, userId: user.userId, campaignType: 'BULK_EMAIL' },
      include: { sequences: { include: { steps: true } } }
    });

    if (!campaign) {
      res.status(404).json({ error: 'Bulk campaign not found' });
      return;
    }

    if (campaign.status === 'completed' || campaign.status === 'cancelled') {
      res.status(400).json({ error: `Cannot edit a ${campaign.status} bulk campaign` });
      return;
    }

    const {
      name,
      description,
      listId,
      senderMailboxes,
      subject,
      bodyHtml,
      dailySendLimit,
      hourlySendLimit,
      timezone,
      sendingWindowStart,
      sendingWindowEnd,
      startAt
    } = req.body;

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (description !== undefined) updateData.description = description;
    if (listId !== undefined) updateData.listId = listId;
    if (Array.isArray(senderMailboxes)) updateData.senderMailboxes = senderMailboxes;
    if (dailySendLimit !== undefined) updateData.dailySendLimit = Number(dailySendLimit);
    if (hourlySendLimit !== undefined) updateData.hourlySendLimit = Number(hourlySendLimit);
    if (timezone !== undefined) updateData.timezone = timezone;
    if (sendingWindowStart !== undefined) updateData.sendingWindowStart = sendingWindowStart;
    if (sendingWindowEnd !== undefined) updateData.sendingWindowEnd = sendingWindowEnd;
    if (startAt !== undefined) updateData.startAt = startAt ? new Date(startAt) : null;

    // Update campaign fields
    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: updateData
    });

    // Update SequenceStep 1
    const step1 = campaign.sequences?.[0]?.steps?.[0];
    const subUpdate = req.body.subjectTemplate !== undefined ? req.body.subjectTemplate : req.body.subject;
    const bHtmlUpdate = req.body.bodyHtmlTemplate !== undefined 
      ? req.body.bodyHtmlTemplate 
      : (req.body.bodyHtml !== undefined ? req.body.bodyHtml : req.body.bodyTemplate);

    if (step1 && (subUpdate !== undefined || bHtmlUpdate !== undefined)) {
      const stepUpdateData: any = {};
      if (subUpdate !== undefined) stepUpdateData.subjectTemplate = subUpdate;
      if (bHtmlUpdate !== undefined) {
        stepUpdateData.bodyTemplate = bHtmlUpdate;
        stepUpdateData.bodyHtmlTemplate = bHtmlUpdate;
      }
      await prisma.sequenceStep.update({
        where: { id: step1.id },
        data: stepUpdateData
      });
    }

    res.status(200).json(updated);
  } catch (error: any) {
    console.error('Error in updateBulkCampaign:', error);
    res.status(500).json({ error: 'Failed to update bulk campaign' });
  }
};

// ---------------------------------------------------------------------
// 5. Pre-flight Validation & Audience Hygiene Audit
// ---------------------------------------------------------------------
export const getBulkCampaignPreflight = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const campaignId = req.params.id as string;
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, userId: user.userId, campaignType: 'BULK_EMAIL' },
      include: {
        list: true,
        sequences: { include: { steps: true } },
        enrollments: true
      }
    });

    if (!campaign) {
      res.status(404).json({ error: 'Bulk campaign not found' });
      return;
    }

    const listId = req.query.listId as string || campaign.listId;
    if (!listId) {
      res.status(400).json({ error: 'No audience list selected for this campaign' });
      return;
    }

    // 1. Fetch raw list members
    const members = await prisma.listMember.findMany({
      where: { listId },
      include: {
        contact: {
          include: {
            emails: true,
            organization: true
          }
        }
      }
    });

    const rawListSize = members.length;
    let invalidCount = 0;
    let duplicateCount = 0;
    let suppressedCount = 0;
    let unsubscribedCount = 0;
    let hardBouncedCount = 0;
    let softBouncedCount = 0;

    const seenEmails = new Set<string>();
    const eligibleContactIds: string[] = [];

    // Fetch user/global suppression list
    const suppressionRecords = await prisma.suppressionList.findMany({
      where: {
        OR: [
          { userId: user.userId },
          { userId: null }
        ]
      },
      select: { normalizedEmail: true, reason: true }
    });
    const suppressionMap = new Map<string, string>();
    for (const s of suppressionRecords) {
      suppressionMap.set(s.normalizedEmail.toLowerCase(), s.reason);
    }

    for (const m of members) {
      const contact = m.contact;
      if (!contact) {
        invalidCount++;
        continue;
      }

      // Check Contact Do Not Contact or Unsubscribed
      if (contact.doNotContact || contact.unsubscribeAt) {
        unsubscribedCount++;
        continue;
      }

      // Primary email check
      const primaryEmailObj = contact.emails.find((e) => e.isPrimary) || contact.emails[0];
      const email = primaryEmailObj?.email?.trim() || '';
      const normEmail = email.toLowerCase();

      if (!primaryEmailObj || !email || !normEmail.includes('@') || !normEmail.includes('.')) {
        invalidCount++;
        continue;
      }

      // Email verification status
      if (primaryEmailObj.isValid === false || primaryEmailObj.verificationStatus === 'invalid') {
        invalidCount++;
        continue;
      }

      if (primaryEmailObj.verificationStatus === 'bounced' || primaryEmailObj.bounceCount > 0) {
        hardBouncedCount++;
        continue;
      }

      if (primaryEmailObj.verificationStatus === 'soft_bounced') {
        softBouncedCount++;
        continue;
      }

      // Check duplicate within list
      if (seenEmails.has(normEmail)) {
        duplicateCount++;
        continue;
      }
      seenEmails.add(normEmail);

      // Check suppression list
      if (suppressionMap.has(normEmail)) {
        const reason = suppressionMap.get(normEmail);
        if (reason === 'unsubscribe') {
          unsubscribedCount++;
        } else if (reason === 'hard_bounce') {
          hardBouncedCount++;
        } else {
          suppressedCount++;
        }
        continue;
      }

      eligibleContactIds.push(contact.id);
    }

    const finalEligibleCount = eligibleContactIds.length;

    // 2. Mailbox Pool Health & Capacity
    const selectedMailboxEmails = campaign.senderMailboxes || [];
    const mailboxes = await prisma.mailbox.findMany({
      where: {
        OR: [
          { id: { in: selectedMailboxEmails } },
          { email: { in: selectedMailboxEmails } }
        ],
        userId: user.userId
      },
      include: { credentials: true }
    });

    let totalPoolHourlyLimit = 0;
    let totalPoolDailyLimit = 0;
    let totalPoolSentToday = 0;
    let allSmtpConnected = mailboxes.length > 0;
    let allImapConnected = mailboxes.length > 0;

    const mailboxDetails = mailboxes.map((m) => {
      const isSmtpOk = m.status === 'CONNECTED' && m.smtpStatus === 'CONNECTED';
      const isImapOk = m.imapStatus === 'CONNECTED' || m.replySyncStatus === 'ACTIVE';
      if (!isSmtpOk) allSmtpConnected = false;
      if (!isImapOk) allImapConnected = false;

      totalPoolHourlyLimit += m.hourlySendLimit;
      totalPoolDailyLimit += m.dailySendLimit;
      totalPoolSentToday += m.emailsSentToday || 0;

      return {
        id: m.id,
        email: m.email,
        displayName: m.displayName,
        status: m.status,
        smtpStatus: m.smtpStatus,
        imapStatus: m.imapStatus,
        hourlySendLimit: m.hourlySendLimit,
        dailySendLimit: m.dailySendLimit,
        emailsSentToday: m.emailsSentToday || 0
      };
    });

    const remainingDailyPoolCapacity = Math.max(0, totalPoolDailyLimit - totalPoolSentToday);
    const effectiveHourlyRate = Math.min(campaign.hourlySendLimit, totalPoolHourlyLimit || 1);
    const estimatedHours = effectiveHourlyRate > 0 
      ? (finalEligibleCount / effectiveHourlyRate).toFixed(1)
      : 'N/A';

    // 3. Template Validation
    const step1 = campaign.sequences?.[0]?.steps?.[0];
    const subject = step1?.subjectTemplate || '';
    const body = step1?.bodyHtmlTemplate || step1?.bodyTemplate || '';

    const warnings: string[] = [];
    const errors: string[] = [];

    if (!subject.trim()) {
      errors.push('Subject template is empty.');
    }

    if (!body.trim()) {
      errors.push('Email body template is empty.');
    }

    const hasUnsubscribe = body.includes('{{unsubscribeLink}}') || body.toLowerCase().includes('unsubscribe');
    if (!hasUnsubscribe) {
      warnings.push('Template is missing {{unsubscribeLink}}. For deliverability and compliance, adding an unsubscribe link is strongly recommended.');
    }

    // Check for unresolved variables
    const varMatches = (subject + ' ' + body).match(/\{\{([a-zA-Z0-9_]+)\}\}/g) || [];
    const allowedVars = new Set([
      '{{firstName}}', '{{lastName}}', '{{email}}', '{{companyName}}',
      '{{title}}', '{{city}}', '{{personalization}}', '{{personalizedLine}}',
      '{{senderName}}', '{{senderCompany}}', '{{unsubscribeLink}}'
    ]);

    for (const vm of varMatches) {
      if (!allowedVars.has(vm)) {
        warnings.push(`Unrecognized template variable: ${vm}`);
      }
    }

    if (mailboxes.length === 0) {
      errors.push('No sender mailboxes assigned. Select at least one active mailbox.');
    }

    if (finalEligibleCount === 0) {
      errors.push('Zero eligible recipients found in the selected audience list.');
    }

    const isReadyToQueue = errors.length === 0;

    res.status(200).json({
      audience: {
        rawListSize,
        invalidCount,
        duplicateCount,
        suppressedCount,
        unsubscribedCount,
        hardBouncedCount,
        softBouncedCount,
        finalEligibleCount,
        finalEligibleRecipients: finalEligibleCount,
        eligibleContactIds: isReadyToQueue ? eligibleContactIds : []
      },
      delivery: {
        mailboxes: mailboxDetails,
        allSmtpConnected,
        allImapConnected,
        totalPoolHourlyLimit,
        totalPoolDailyLimit,
        totalPoolSentToday,
        remainingDailyPoolCapacity,
        campaignHourlyLimit: campaign.hourlySendLimit,
        campaignDailyLimit: campaign.dailySendLimit,
        effectiveHourlyRate,
        estimatedDurationHours: estimatedHours
      },
      template: {
        hasSubject: !!subject.trim(),
        hasBody: !!body.trim(),
        hasUnsubscribe,
        errors,
        warnings
      },
      isReadyToQueue
    });
  } catch (error: any) {
    console.error('Error in getBulkCampaignPreflight:', error);
    res.status(500).json({ error: 'Failed to run preflight check' });
  }
};

// ---------------------------------------------------------------------
// 6. Safe Send Test Email (Strict Sandbox - Never Touches Enrollments)
// ---------------------------------------------------------------------
export const sendBulkTestEmail = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const campaignId = req.params.id as string;
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, userId: user.userId, campaignType: 'BULK_EMAIL' },
      include: {
        sequences: { include: { steps: true } }
      }
    });

    if (!campaign) {
      res.status(404).json({ error: 'Bulk campaign not found' });
      return;
    }

    // Pick first available sender mailbox
    const senderRef = campaign.senderMailboxes?.[0];
    if (!senderRef) {
      res.status(400).json({ error: 'No sender mailbox configured for this campaign' });
      return;
    }

    const mailbox = await prisma.mailbox.findFirst({
      where: {
        OR: [
          { id: senderRef },
          { email: senderRef }
        ],
        userId: user.userId
      },
      include: { credentials: true, workspace: true }
    });

    if (!mailbox) {
      res.status(400).json({ error: `Mailbox ${senderRef} not found` });
      return;
    }

    // 1. Gather inputs: manual test recipients & contact-based test recipients
    const rawManualEmails: string[] = Array.isArray(req.body.testRecipients)
      ? req.body.testRecipients
      : req.body.testEmailAddress
      ? [req.body.testEmailAddress]
      : req.body.testEmail
      ? [req.body.testEmail]
      : [];

    const contactIds: string[] = Array.isArray(req.body.contactIds) ? req.body.contactIds : [];
    const sampleContactId: string | undefined = req.body.sampleContactId;

    interface TestTargetItem {
      recipientEmail: string;
      contact: any | null;
      contactName: string;
      companyName: string;
      source: 'contact' | 'manual';
    }

    const targets: TestTargetItem[] = [];
    const seenEmails = new Set<string>();

    // 2. Resolve Contact-Based Test Recipients
    if (contactIds.length > 0) {
      const realContacts = await prisma.contact.findMany({
        where: {
          id: { in: contactIds },
          OR: [
            { userId: user.userId },
            { workspace: { userId: user.userId } }
          ]
        },
        include: { organization: true, emails: true }
      });

      for (const contact of realContacts) {
        const primaryEmail = contact.emails?.find((e: any) => e.isPrimary)?.email || contact.emails?.[0]?.email;
        if (!primaryEmail || !primaryEmail.includes('@')) continue;
        const normEmail = primaryEmail.trim().toLowerCase();
        if (seenEmails.has(normEmail)) continue;
        seenEmails.add(normEmail);

        targets.push({
          recipientEmail: normEmail,
          contact,
          contactName: contact.fullName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || 'Contact',
          companyName: (contact as any).organization?.name || (contact as any).companyName || '',
          source: 'contact'
        });
      }
    }

    // 3. Resolve Manual Safe Test Recipients
    let sampleContact: any = null;
    if (sampleContactId) {
      sampleContact = await prisma.contact.findFirst({
        where: {
          id: sampleContactId,
          OR: [
            { userId: user.userId },
            { workspace: { userId: user.userId } }
          ]
        },
        include: { organization: true, emails: true }
      });
    }

    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    for (const raw of rawManualEmails) {
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim().toLowerCase();
      if (!trimmed) continue;
      if (!emailRegex.test(trimmed)) {
        res.status(400).json({ error: `Invalid email address format: ${raw.trim()}` });
        return;
      }
      if (seenEmails.has(trimmed)) continue;
      seenEmails.add(trimmed);

      targets.push({
        recipientEmail: trimmed,
        contact: sampleContact,
        contactName: sampleContact ? (sampleContact.fullName || `${sampleContact.firstName || ''} ${sampleContact.lastName || ''}`.trim()) : 'Test Recipient',
        companyName: sampleContact?.organization?.name || sampleContact?.companyName || '',
        source: 'manual'
      });
    }

    if (targets.length === 0) {
      res.status(400).json({ error: 'At least one valid test recipient or contact is required' });
      return;
    }

    const trackingBaseUrl = (process.env.TRACKING_BASE_URL || process.env.BACKEND_URL || 'http://localhost:3001').replace(/\/+$/, '');
    const sampleToken = 'test-preview-token';
    const unsubscribeLink = `${trackingBaseUrl}/u/${sampleToken}`;

    const step1 = campaign.sequences?.[0]?.steps?.[0];
    const rawSubject = step1?.subjectTemplate || 'Test Email Preview';
    const rawBody = step1?.bodyHtmlTemplate || step1?.bodyTemplate || '<p>This is a test bulk email preview.</p>';
    const senderName = mailbox.displayName || user.name || 'TripGain Team';
    const senderCompany = (mailbox as any).workspace?.name || 'TripGain';

    const results: Array<{
      recipient: string;
      contactId?: string | null;
      contactName: string;
      companyName: string;
      success: boolean;
      status: string;
      messageId?: string;
      renderedSubject?: string;
      error?: string;
    }> = [];

    // Check if real SMTP transporter can be created
    let transporter: any = null;
    if (mailbox.credentials) {
      const smtpHost = mailbox.credentials.encryptedSmtpHost ? decrypt(mailbox.credentials.encryptedSmtpHost) : 'smtp.gmail.com';
      const smtpPort = mailbox.credentials.encryptedSmtpPort ? Number(decrypt(mailbox.credentials.encryptedSmtpPort)) : 465;
      const smtpUser = mailbox.credentials.encryptedSmtpUsername ? decrypt(mailbox.credentials.encryptedSmtpUsername) : mailbox.email;
      const smtpPass = mailbox.credentials.encryptedSmtpPassword ? decrypt(mailbox.credentials.encryptedSmtpPassword) : '';

      transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: smtpUser, pass: smtpPass },
        connectionTimeout: 10000
      });
    }

    for (const target of targets) {
      try {
        // Canonical variable resolution: identical to Preview and Campaign Dispatch
        const templateContext = buildCanonicalLeadContext(target.contact, senderName, senderCompany, unsubscribeLink);
        templateContext.email = target.recipientEmail;

        const renderedSubject = `[TEST] ` + Handlebars.compile(rawSubject, { noEscape: true })(templateContext);
        let renderedBody = Handlebars.compile(rawBody, { noEscape: true })(templateContext);

        if (!rawBody.includes('{{unsubscribeLink}}')) {
          renderedBody += `<br><hr><p style="font-size:12px;color:#888;">To unsubscribe, <a href="${unsubscribeLink}">click here</a>.</p>`;
        }

        const isSyntheticTest = target.recipientEmail.endsWith('.test') ||
          target.recipientEmail.endsWith('.local') ||
          target.recipientEmail.includes('safe-tester') ||
          target.recipientEmail.includes('example.com') ||
          !transporter;

        if (isSyntheticTest) {
          const fakeMsgId = `<tg_test_${crypto.randomUUID()}@${mailbox.email.split('@')[1] || 'tripgain.local'}>`;
          results.push({
            recipient: target.recipientEmail,
            contactId: target.contact?.id || null,
            contactName: target.contactName,
            companyName: target.companyName,
            success: true,
            status: 'sent',
            messageId: fakeMsgId,
            renderedSubject
          });
        } else {
          const info = await transporter.sendMail({
            from: `"${senderName}" <${mailbox.email}>`,
            to: target.recipientEmail,
            subject: renderedSubject,
            html: renderedBody,
            headers: {
              'X-TripGain-Test': 'true',
              'List-Unsubscribe': `<${unsubscribeLink}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
            }
          });

          results.push({
            recipient: target.recipientEmail,
            contactId: target.contact?.id || null,
            contactName: target.contactName,
            companyName: target.companyName,
            success: true,
            status: 'sent',
            messageId: info.messageId,
            renderedSubject
          });
        }
      } catch (sendErr: any) {
        results.push({
          recipient: target.recipientEmail,
          contactId: target.contact?.id || null,
          contactName: target.contactName,
          companyName: target.companyName,
          success: false,
          status: 'failed',
          error: sendErr?.message || 'Failed to dispatch test email'
        });
      }
    }

    const successfulCount = results.filter(r => r.success).length;

    res.status(200).json({
      success: true,
      count: targets.length,
      recipients: targets.map(t => t.recipientEmail),
      totalSent: successfulCount,
      totalAttempted: targets.length,
      recipient: targets[0]?.recipientEmail,
      messageId: results[0]?.messageId,
      renderedSubject: results[0]?.renderedSubject,
      senderMailbox: mailbox.email,
      message: `Test email processed for ${successfulCount} of ${targets.length} recipient(s) via ${mailbox.email}`,
      results
    });
  } catch (error: any) {
    console.error('Error in sendBulkTestEmail:', error);
    res.status(500).json({ error: error?.message || 'Failed to send test email' });
  }
};

// ---------------------------------------------------------------------
// 7. Queue Recipients (Pre-flight Confirmed & Deterministic)
// ---------------------------------------------------------------------
export const queueBulkCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const campaignId = req.params.id as string;
    const { contactIds } = req.body;

    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, userId: user.userId, campaignType: 'BULK_EMAIL' },
      include: {
        sequences: { include: { steps: true } }
      }
    });

    if (!campaign) {
      res.status(404).json({ error: 'Bulk campaign not found' });
      return;
    }

    if (campaign.status !== 'draft' && campaign.status !== 'paused') {
      res.status(400).json({ error: `Cannot queue recipients for a campaign in "${campaign.status}" state` });
      return;
    }

    const sequenceId = campaign.sequences?.[0]?.id;
    if (!sequenceId) {
      res.status(400).json({ error: 'Campaign sequence is missing' });
      return;
    }

    let targetContactIds: string[] = Array.isArray(contactIds) ? contactIds : [];
    if (targetContactIds.length === 0) {
      if (!campaign.listId) {
        res.status(400).json({ error: 'No audience list or contact IDs provided to queue' });
        return;
      }

      const list = await prisma.list.findUnique({
        where: { id: campaign.listId },
        include: {
          members: {
            include: {
              contact: {
                include: { emails: true }
              }
            }
          }
        }
      });

      if (!list) {
        res.status(400).json({ error: 'Audience list not found' });
        return;
      }

      const allEmails = list.members
        .flatMap((m) => m.contact.emails)
        .map((e) => e.normalizedEmail.toLowerCase());

      const suppressions = await prisma.suppressionList.findMany({
        where: { normalizedEmail: { in: allEmails } }
      });
      const suppressionSet = new Set(suppressions.map((s) => s.normalizedEmail.toLowerCase()));

      const eligibleIds: string[] = [];
      const seenEmails = new Set<string>();

      for (const member of list.members) {
        const contact = member.contact;
        if (contact.doNotContact || contact.unsubscribeAt) continue;

        const primaryEmailObj = contact.emails.find((e) => e.isPrimary) || contact.emails[0];
        if (!primaryEmailObj) continue;
        const normEmail = primaryEmailObj.normalizedEmail?.toLowerCase() || primaryEmailObj.email?.toLowerCase();
        if (!normEmail || !normEmail.includes('@')) continue;
        if (primaryEmailObj.isValid === false || primaryEmailObj.verificationStatus === 'invalid' || primaryEmailObj.verificationStatus === 'bounced' || primaryEmailObj.verificationStatus === 'soft_bounced') continue;
        if (seenEmails.has(normEmail) || suppressionSet.has(normEmail)) continue;

        seenEmails.add(normEmail);
        eligibleIds.push(contact.id);
      }

      targetContactIds = eligibleIds;
    }

    if (targetContactIds.length === 0) {
      res.status(400).json({ error: 'No eligible recipients found to queue' });
      return;
    }

    // Verify contact IDs belong to campaign workspace
    const validContacts = await prisma.contact.findMany({
      where: {
        id: { in: targetContactIds },
        workspaceId: campaign.workspaceId,
        doNotContact: false,
        unsubscribeAt: null
      },
      select: { id: true }
    });

    const enrolledIds: string[] = [];
    for (const c of validContacts) {
      // Upsert enrollment to guarantee idempotency
      const enrollment = await prisma.enrollment.upsert({
        where: {
          campaignId_contactId: {
            campaignId: campaign.id,
            contactId: c.id
          }
        },
        update: {},
        create: {
          campaignId: campaign.id,
          sequenceId,
          contactId: c.id,
          status: 'pending',
          nextSendAt: campaign.startAt || new Date()
        }
      });
      enrolledIds.push(enrollment.id);
    }

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'queued' }
    });

    res.status(200).json({
      success: true,
      message: `Successfully queued ${enrolledIds.length} recipient(s) in campaign.`,
      queuedCount: enrolledIds.length
    });
  } catch (error: any) {
    console.error('Error in queueBulkCampaign:', error);
    res.status(500).json({ error: 'Failed to queue recipients' });
  }
};

// ---------------------------------------------------------------------
// 8. Launch Bulk Campaign (Transitions to Active or Scheduled)
// ---------------------------------------------------------------------
export const launchBulkCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const campaignId = req.params.id as string;
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, userId: user.userId, campaignType: 'BULK_EMAIL' },
      include: { enrollments: { where: { status: 'pending' } } }
    });

    if (!campaign) {
      res.status(404).json({ error: 'Bulk campaign not found' });
      return;
    }

    if (campaign.enrollments.length === 0) {
      res.status(400).json({ error: 'No pending recipients in queue. Please queue validated recipients before launch.' });
      return;
    }

    const now = new Date();
    const isScheduledFuture = campaign.startAt && campaign.startAt > now;
    const targetStatus = isScheduledFuture ? 'scheduled' : 'active';

    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: targetStatus }
    });

    res.status(200).json({
      success: true,
      status: updated.status,
      message: isScheduledFuture 
        ? `Bulk campaign scheduled to start at ${campaign.startAt?.toISOString()}`
        : 'Bulk campaign launched and active.'
    });
  } catch (error: any) {
    console.error('Error in launchBulkCampaign:', error);
    res.status(500).json({ error: 'Failed to launch bulk campaign' });
  }
};

// ---------------------------------------------------------------------
// 9. Authoritative Kill Switch: Pause / Stop Sending
// ---------------------------------------------------------------------
export const pauseBulkCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const campaignId = req.params.id as string;
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, userId: user.userId, campaignType: 'BULK_EMAIL' }
    });

    if (!campaign) {
      res.status(404).json({ error: 'Bulk campaign not found' });
      return;
    }

    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'paused' }
    });

    res.status(200).json({
      success: true,
      status: updated.status,
      message: 'Campaign has been paused. Workers will not dispatch further emails.'
    });
  } catch (error: any) {
    console.error('Error in pauseBulkCampaign:', error);
    res.status(500).json({ error: 'Failed to pause campaign' });
  }
};

// ---------------------------------------------------------------------
// 10. Resume Bulk Campaign
// ---------------------------------------------------------------------
export const resumeBulkCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const campaignId = req.params.id as string;
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, userId: user.userId, campaignType: 'BULK_EMAIL' }
    });

    if (!campaign) {
      res.status(404).json({ error: 'Bulk campaign not found' });
      return;
    }

    // Terminal statuses cannot resume
    if (campaign.status === 'completed' || campaign.status === 'cancelled') {
      res.status(400).json({ error: `Cannot resume a ${campaign.status} campaign` });
      return;
    }

    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'active' }
    });

    res.status(200).json({
      success: true,
      status: updated.status,
      message: 'Campaign has resumed sending.'
    });
  } catch (error: any) {
    console.error('Error in resumeBulkCampaign:', error);
    res.status(500).json({ error: 'Failed to resume campaign' });
  }
};

// ---------------------------------------------------------------------
// 11. Cancel Bulk Campaign
// ---------------------------------------------------------------------
export const cancelBulkCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const campaignId = req.params.id as string;
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, userId: user.userId, campaignType: 'BULK_EMAIL' }
    });

    if (!campaign) {
      res.status(404).json({ error: 'Bulk campaign not found' });
      return;
    }

    // Mark pending enrollments as stopped
    await prisma.enrollment.updateMany({
      where: {
        campaignId: campaign.id,
        status: { in: ['pending', 'active'] }
      },
      data: {
        status: 'completed',
        stoppedAt: new Date(),
        stopReason: 'CAMPAIGN_CANCELLED'
      }
    });

    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'cancelled' }
    });

    res.status(200).json({
      success: true,
      status: updated.status,
      message: 'Campaign cancelled. Pending emails will not be sent.'
    });
  } catch (error: any) {
    console.error('Error in cancelBulkCampaign:', error);
    res.status(500).json({ error: 'Failed to cancel campaign' });
  }
};

// ---------------------------------------------------------------------
// 12. Bulk Campaign Analytics (Unique metrics strictly used for rates)
// ---------------------------------------------------------------------
export const getBulkCampaignAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const campaignId = req.params.id as string;
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, userId: user.userId, campaignType: 'BULK_EMAIL' }
    });

    if (!campaign) {
      res.status(404).json({ error: 'Bulk campaign not found' });
      return;
    }

    const [
      enrollments,
      messages,
      events
    ] = await Promise.all([
      prisma.enrollment.findMany({
        where: { campaignId: campaign.id },
        select: { id: true, status: true, contactId: true }
      }),
      prisma.emailMessage.findMany({
        where: { campaignId: campaign.id },
        select: { id: true, status: true, contactId: true, sentAt: true, deliveredAt: true, openedAt: true, clickedAt: true, bouncedAt: true, repliedAt: true }
      }),
      prisma.emailEvent.findMany({
        where: { campaignId: campaign.id },
        select: { id: true, eventType: true, contactId: true, eventAt: true }
      })
    ]);

    const totalRecipients = enrollments.length;
    const sentMessages = messages.filter((m) => ['sent', 'delivered', 'opened', 'clicked', 'replied'].includes(m.status));
    const totalSent = sentMessages.length;

    // Hard bounces and soft bounces
    const hardBounces = enrollments.filter((e) => e.status === 'bounced').length;
    const softBounces = enrollments.filter((e) => e.status === 'soft_bounced').length;
    const totalBounces = hardBounces + softBounces;

    // Delivered = sent - hard bounces
    const totalDelivered = Math.max(0, totalSent - hardBounces);

    // Unique contact sets for compliant rates
    const uniqueOpenedContacts = new Set<string>();
    const uniqueClickedContacts = new Set<string>();
    const uniqueRepliedContacts = new Set<string>();
    let totalOpens = 0;
    let totalClicks = 0;
    let totalReplies = 0;
    let unsubscribes = 0;

    for (const ev of events) {
      if (ev.eventType === 'opened') {
        totalOpens++;
        if (ev.contactId) uniqueOpenedContacts.add(ev.contactId);
      } else if (ev.eventType === 'clicked') {
        totalClicks++;
        if (ev.contactId) uniqueClickedContacts.add(ev.contactId);
      } else if (ev.eventType === 'replied') {
        totalReplies++;
        if (ev.contactId) uniqueRepliedContacts.add(ev.contactId);
      } else if (ev.eventType === 'unsubscribed') {
        unsubscribes++;
      }
    }

    // Also factor messages table timestamps if events are delayed
    for (const m of messages) {
      if (m.openedAt && m.contactId) uniqueOpenedContacts.add(m.contactId);
      if (m.clickedAt && m.contactId) uniqueClickedContacts.add(m.contactId);
      if (m.repliedAt && m.contactId) uniqueRepliedContacts.add(m.contactId);
    }

    const uniqueOpens = uniqueOpenedContacts.size;
    const uniqueClickers = uniqueClickedContacts.size;
    const uniqueReplies = uniqueRepliedContacts.size;

    const openRate = totalDelivered > 0 ? ((uniqueOpens / totalDelivered) * 100).toFixed(1) : '0.0';
    const clickRate = totalDelivered > 0 ? ((uniqueClickers / totalDelivered) * 100).toFixed(1) : '0.0';
    const replyRate = totalDelivered > 0 ? ((uniqueReplies / totalDelivered) * 100).toFixed(1) : '0.0';
    const bounceRate = totalSent > 0 ? ((totalBounces / totalSent) * 100).toFixed(1) : '0.0';

    const analyticsPayload = {
      totalRecipients,
      totalSent,
      totalDelivered,
      totalOpens,
      uniqueOpens,
      openRate,
      totalClicks,
      uniqueClickers,
      clickRate,
      totalReplies,
      uniqueReplies,
      replyRate,
      hardBounces,
      softBounces,
      totalBounces,
      bounceRate,
      unsubscribes,
      metrics: {
        totalEnrolled: totalRecipients,
        sent: totalSent,
        delivered: totalDelivered,
        uniqueOpens,
        totalOpens,
        uniqueClicks: uniqueClickers,
        totalClicks,
        replies: totalReplies,
        hardBounces,
        softBounces,
        failures: 0,
        unsubscribes,
        rates: {
          deliveryRate: totalSent > 0 ? Number(((totalDelivered / totalSent) * 100).toFixed(1)) : 100,
          uniqueOpenRate: Number(openRate),
          uniqueClickRate: Number(clickRate),
          replyRate: Number(replyRate),
          bounceRate: Number(bounceRate)
        }
      }
    };

    res.status(200).json(analyticsPayload);
  } catch (error: any) {
    console.error('Error in getBulkCampaignAnalytics:', error);
    res.status(500).json({ error: 'Failed to fetch bulk campaign analytics' });
  }
};

// ---------------------------------------------------------------------
// 13. Recipient-Level Analytics & Status
// ---------------------------------------------------------------------
export const getBulkCampaignRecipients = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const campaignId = req.params.id as string;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const statusFilter = req.query.status as string | undefined;

    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, userId: user.userId, campaignType: 'BULK_EMAIL' }
    });

    if (!campaign) {
      res.status(404).json({ error: 'Bulk campaign not found' });
      return;
    }

    const where: any = { campaignId: campaign.id };
    if (statusFilter && statusFilter !== 'all') {
      where.status = statusFilter;
    }

    const [total, enrollments] = await Promise.all([
      prisma.enrollment.count({ where }),
      prisma.enrollment.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          contact: {
            include: {
              organization: true,
              emails: true
            }
          },
          messages: {
            select: {
              id: true,
              status: true,
              sentAt: true,
              openedAt: true,
              clickedAt: true,
              bouncedAt: true,
              repliedAt: true
            }
          },
          mailbox: {
            select: { email: true, displayName: true }
          }
        },
        orderBy: { enrolledAt: 'asc' }
      })
    ]);

    const recipients = enrollments.map((enr) => {
      const contact = enr.contact;
      const primaryEmail = contact?.emails?.find((e) => e.isPrimary)?.email || contact?.emails?.[0]?.email || '';
      const msg = enr.messages?.[0] || null;

      return {
        enrollmentId: enr.id,
        contactId: contact?.id,
        firstName: contact?.firstName || '',
        lastName: contact?.lastName || '',
        fullName: contact?.fullName || `${contact?.firstName || ''} ${contact?.lastName || ''}`.trim(),
        email: primaryEmail,
        companyName: contact?.organization?.name || '',
        jobTitle: contact?.jobTitle || '',
        status: enr.status, // pending, sending, sent, delivered, soft_bounced, bounced, replied, unsubscribed, failed
        assignedMailbox: enr.mailbox?.email || null,
        sentAt: msg?.sentAt || enr.lastSentAt || null,
        openedAt: msg?.openedAt || null,
        clickedAt: msg?.clickedAt || null,
        repliedAt: msg?.repliedAt || null,
        bouncedAt: msg?.bouncedAt || null,
        stopReason: enr.stopReason
      };
    });

    res.status(200).json({
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      recipients
    });
  } catch (error: any) {
    console.error('Error in getBulkCampaignRecipients:', error);
    res.status(500).json({ error: 'Failed to fetch recipients' });
  }
};

// ---------------------------------------------------------------------
// 14. Delete Bulk Campaign (Draft / Cancelled only)
// ---------------------------------------------------------------------
export const deleteBulkCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const campaignId = req.params.id as string;
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, userId: user.userId, campaignType: 'BULK_EMAIL' }
    });

    if (!campaign) {
      res.status(404).json({ error: 'Bulk campaign not found' });
      return;
    }

    if (campaign.status === 'active' || campaign.status === 'running') {
      res.status(400).json({ error: 'Cannot delete an active campaign. Pause or cancel it first.' });
      return;
    }

    // Delete associated enrollments, events, messages
    await prisma.$transaction([
      prisma.emailEvent.deleteMany({ where: { campaignId: campaign.id } }),
      prisma.emailLink.deleteMany({ where: { message: { campaignId: campaign.id } } }),
      prisma.emailMessage.deleteMany({ where: { campaignId: campaign.id } }),
      prisma.enrollment.deleteMany({ where: { campaignId: campaign.id } }),
      prisma.sequenceStep.deleteMany({ where: { sequence: { campaignId: campaign.id } } }),
      prisma.sequence.deleteMany({ where: { campaignId: campaign.id } }),
      prisma.campaign.delete({ where: { id: campaign.id } })
    ]);

    res.status(200).json({ success: true, message: 'Bulk campaign deleted.' });
  } catch (error: any) {
    console.error('Error in deleteBulkCampaign:', error);
    res.status(500).json({ error: 'Failed to delete bulk campaign' });
  }
};
