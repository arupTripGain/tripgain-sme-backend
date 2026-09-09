import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const getWorkspace = async () => {
  let workspace = await prisma.workspace.findFirst();
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

export const getCampaigns = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const scope = req.query.scope as string | undefined;

    let whereClause: any = {};
    if (user) {
      if (user.role === 'ADMIN' && scope === 'all') {
        // Admin viewing all workspace campaigns
      } else {
        whereClause.OR = [
          { userId: user.userId },
          { owner: user.name },
          { owner: user.email }
        ];
      }
    }

    const campaigns = await prisma.campaign.findMany({
      where: whereClause,
      include: {
        sequences: {
          include: {
            steps: true
          }
        },
        enrollments: {
          select: { id: true, status: true }
        },
        messages: {
          select: { id: true, status: true, sentAt: true, enrollmentId: true, toEmail: true }
        },
        events: {
          select: { id: true, eventType: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    const formatted = campaigns.map(c => {
      const enrolledCount = c.enrollments.length;
      const stepsCount = c.sequences.reduce((sum, seq) => sum + (seq.steps?.length || 0), 0);
      
      const validStatuses = ['sent', 'delivered', 'opened', 'clicked', 'replied', 'bounced'];
      const dispatchedMessages = c.messages.filter(m => 
        validStatuses.includes(m.status) || (m.sentAt !== null && m.status !== 'failed' && m.status !== 'draft' && m.status !== 'pending')
      );
      const sentCount = dispatchedMessages.length;

      const uniqueSentContacts = new Set<string>();
      dispatchedMessages.forEach(m => {
        if (m.enrollmentId) uniqueSentContacts.add(m.enrollmentId);
        else if (m.toEmail) uniqueSentContacts.add(m.toEmail.toLowerCase());
      });
      const uniqueSentCount = uniqueSentContacts.size;

      const repliedEnrollments = c.enrollments.filter(e => e.status === 'replied').length;
      const repliedEvents = c.events.filter(e => e.eventType === 'replied' || e.eventType === 'email.replied').length;
      const repliesCount = Math.max(repliedEnrollments, repliedEvents);
      const replyRate = uniqueSentCount > 0 ? Math.min(100, Math.round((repliesCount / uniqueSentCount) * 100)) : 0;
      const senderEmail = c.senderMailboxes?.[0] || null;
      const replyToEmail = c.replyToEmail || senderEmail;

      return {
        ...c,
        enrolledCount,
        stepsCount,
        sentCount,
        totalSentMessages: sentCount,
        uniqueSentCount,
        repliesCount,
        replyRate,
        senderEmail,
        replyToEmail,
        _count: {
          enrollments: enrolledCount,
          sequences: c.sequences.length,
          leads: enrolledCount,
          steps: stepsCount
        }
      };
    });
    
    res.status(200).json(formatted);
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
};

export const getCampaignById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const campaign = await prisma.campaign.findUnique({
      where: { id: String(id) },
      include: {
        list: true,
        sequences: {
          include: {
            steps: {
              orderBy: { stepNumber: 'asc' }
            }
          }
        },
        _count: {
          select: { enrollments: true }
        }
      }
    });
    
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const sentCount = await prisma.emailMessage.count({
      where: { 
        campaignId: campaign.id, 
        OR: [
          { status: { in: ['sent', 'delivered', 'opened', 'clicked', 'replied', 'bounced'] } },
          { sentAt: { not: null }, status: { notIn: ['failed', 'draft', 'pending'] } }
        ]
      }
    });

    const repliedCount = await prisma.enrollment.count({
      where: { campaignId: campaign.id, status: 'replied' }
    });

    const stepsCount = campaign.sequences.reduce((sum, seq) => sum + (seq.steps?.length || 0), 0);
    const senderEmail = campaign.senderMailboxes?.[0] || null;
    const replyToEmail = campaign.replyToEmail || senderEmail;
    
    res.status(200).json({
      ...campaign,
      enrolledCount: campaign._count.enrollments,
      stepsCount,
      sentCount,
      totalSentMessages: sentCount,
      repliesCount: repliedCount,
      senderEmail,
      replyToEmail
    });
  } catch (error) {
    console.error('Error fetching campaign:', error);
    res.status(500).json({ error: 'Failed to fetch campaign' });
  }
};

// Phase 5: Campaign Engine - Compose
export const composeCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const { 
      name, description, campaignCode, campaignType,
      listId, audienceRules,
      senderMailboxes, replyToEmail,
      timezone, sendingDays, sendingWindowStart, sendingWindowEnd,
      dailySendLimit, hourlySendLimit, delayBetweenSendsSeconds,
      stopOnReply, openTracking,
      landingPageUrl, utmCampaign,
      sequenceSteps 
    } = req.body;
    
    const workspace = await getWorkspace();
    
    let targetListId = listId;

    // If audienceRules is provided, create a dynamic list for this campaign
    if (audienceRules && Object.keys(audienceRules).length > 0) {
      const newList = await prisma.list.create({
        data: {
          workspaceId: workspace.id,
          name: `${name} - Smart Filter`,
          listType: 'dynamic',
          rules: audienceRules
        }
      });
      targetListId = newList.id;
    }

    const user = (req as any).user;
    const userId = user?.userId || null;
    const ownerName = user?.name || user?.email || 'Arup Nirala';

    // Create Campaign + Sequence + Steps + AuditLog in a transaction
    const campaign = await (prisma as any).campaign.create({
      data: {
        workspaceId: workspace.id,
        userId: userId || undefined,
        owner: ownerName,
        name,
        campaignCode,
        description,
        campaignType: campaignType || 'email_outreach',
        listId: targetListId || null,
        status: 'draft',
        approvalStatus: 'DRAFT',
        senderMailboxes: senderMailboxes || [],
        replyToEmail,
        timezone: timezone || 'UTC',
        sendingDays: sendingDays || ["Mon","Tue","Wed","Thu","Fri"],
        sendingWindowStart: sendingWindowStart || "09:00",
        sendingWindowEnd: sendingWindowEnd || "17:00",
        dailySendLimit: dailySendLimit ? Number(dailySendLimit) : 100,
        hourlySendLimit: hourlySendLimit ? Number(hourlySendLimit) : 20,
        delayBetweenSendsSeconds: delayBetweenSendsSeconds ? Number(delayBetweenSendsSeconds) : 180,
        stopOnReply: stopOnReply !== undefined ? stopOnReply : true,
        openTracking: openTracking !== undefined ? openTracking : true,
        landingPageUrl,
        utmCampaign,
        sequences: {
          create: [{
            name: 'Primary Sequence',
            steps: {
              create: (sequenceSteps || []).map((step: any, idx: number) => ({
                stepNumber: idx + 1,
                stepType: step.type || 'email',
                delayDays: step.delayDays || 0,
                subjectTemplate: step.subject || null,
                bodyTemplate: step.body || null,
              }))
            }
          }]
        },
        auditLogs: {
          create: [{
            action: 'Campaign created',
            details: 'Initial campaign configuration saved as draft.'
          }]
        }
      }
    });
    
    res.status(201).json(campaign);
  } catch (error) {
    console.error('Error composing campaign:', error);
    res.status(500).json({ error: 'Failed to compose campaign' });
  }
};

// Phase 5: Campaign Engine - Activate
export const activateCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    
    const campaign = await prisma.campaign.findUnique({
      where: { id: String(id) },
      include: { 
        sequences: true,
        list: true
      }
    });
    
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    
    if (!campaign.listId) {
      res.status(400).json({ error: 'Campaign has no audience list assigned. Please edit the campaign to assign a list before launching.' });
      return;
    }
    
    let senderMailboxes = campaign.senderMailboxes || [];
    if (senderMailboxes.length === 0) {
      const activeMailbox = await prisma.mailbox.findFirst({
        where: { workspaceId: campaign.workspaceId, status: 'CONNECTED' }
      });
      if (activeMailbox) {
        senderMailboxes = [activeMailbox.email];
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { senderMailboxes }
        });
      } else {
        res.status(400).json({ error: 'Sender mailbox configuration is missing. Please connect or configure a sender mailbox.' });
        return;
      }
    }

    let sequenceId = campaign.sequences[0]?.id;
    if (!sequenceId) {
      const newSeq = await prisma.sequence.create({
        data: {
          campaignId: campaign.id,
          name: 'Primary Sequence'
        }
      });
      sequenceId = newSeq.id;
    }

    // 1. Fetch eligible contacts from the List
    let eligibleContactIds: string[] = [];
    
    if (campaign.list?.listType === 'dynamic' && campaign.list?.rules) {
      const rules = campaign.list.rules as any;
      let whereClause: any = { workspaceId: campaign.workspaceId };
      if (rules.city) whereClause.city = { contains: rules.city, mode: 'insensitive' };
      if (rules.jobTitle) whereClause.jobTitle = { contains: rules.jobTitle, mode: 'insensitive' };
      if (rules.industry) {
        whereClause.organization = { industry: { contains: rules.industry, mode: 'insensitive' } };
      }
      
      const contacts = await prisma.contact.findMany({
        where: whereClause,
        select: { id: true }
      });
      eligibleContactIds = contacts.map(c => c.id);
      
    } else {
      const members = await prisma.listMember.findMany({
        where: { listId: campaign.listId },
        select: { contactId: true }
      });
      eligibleContactIds = members.map(m => m.contactId);
    }
    
    // 2. Filter out already enrolled contacts
    const existingEnrollments = await prisma.enrollment.findMany({
      where: {
        campaignId: campaign.id,
        contactId: { in: eligibleContactIds }
      },
      select: { contactId: true }
    });
    const enrolledIds = new Set(existingEnrollments.map(e => e.contactId));
    
    const newContactIds = eligibleContactIds.filter(id => !enrolledIds.has(id));
    
    // 3. Create new enrollments
    if (newContactIds.length > 0) {
      await prisma.enrollment.createMany({
        data: newContactIds.map(contactId => ({
          campaignId: campaign.id,
          sequenceId,
          contactId,
          status: 'active',
          currentStep: 1,
          nextSendAt: new Date()
        }))
      });
    }

    // 4. Reactivate any existing paused enrollments
    await prisma.enrollment.updateMany({
      where: {
        campaignId: campaign.id,
        status: 'paused'
      },
      data: {
        status: 'active'
      }
    });
    
    // 5. Update campaign status and add audit log
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { 
        status: 'active', 
        approvalStatus: 'APPROVED',
        startAt: new Date(),
        auditLogs: {
          create: [{
            action: 'Campaign activated',
            details: `Activated campaign and sequenced ${newContactIds.length} new contact(s). Total audience: ${eligibleContactIds.length}.`
          }]
        }
      }
    });
    
    res.status(200).json({
      success: true,
      message: 'Campaign launched and sequenced successfully',
      enrolledCount: newContactIds.length,
      totalEligible: eligibleContactIds.length
    });
    
  } catch (error: any) {
    console.error('Error activating campaign:', error);
    res.status(500).json({ error: error?.message || 'Failed to activate campaign' });
  }
};

export const pauseCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const campaign = await prisma.campaign.findUnique({
      where: { id: String(id) }
    });
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        status: 'paused',
        auditLogs: {
          create: [{
            action: 'Campaign paused',
            details: 'Campaign was paused by user.'
          }]
        }
      }
    });
    res.status(200).json({ success: true, message: 'Campaign paused successfully' });
  } catch (error: any) {
    console.error('Error pausing campaign:', error);
    res.status(500).json({ error: error?.message || 'Failed to pause campaign' });
  }
};

export const duplicateCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const original = await prisma.campaign.findUnique({
      where: { id: String(id) },
      include: {
        sequences: {
          include: {
            steps: {
              orderBy: { stepNumber: 'asc' }
            }
          }
        }
      }
    });

    if (!original) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const user = (req as any).user;
    const userId = user?.userId || original.userId || null;
    const ownerName = user?.name || user?.email || original.owner || 'Arup Nirala';

    const uniqueSuffix = Math.floor(1000 + Math.random() * 9000);
    const newCampaignCode = original.campaignCode 
      ? `${original.campaignCode}-copy-${uniqueSuffix}` 
      : null;

    const newCampaign = await prisma.campaign.create({
      data: {
        workspaceId: original.workspaceId,
        userId: userId || undefined,
        owner: ownerName,
        name: `${original.name} (Copy)`,
        campaignCode: newCampaignCode,
        description: original.description,
        campaignType: original.campaignType,
        audienceType: original.audienceType,
        listId: original.listId,
        status: 'draft',
        approvalStatus: 'DRAFT',
        senderMailboxes: original.senderMailboxes,
        replyToEmail: original.replyToEmail,
        dailySendLimit: original.dailySendLimit,
        hourlySendLimit: original.hourlySendLimit,
        delayBetweenSendsSeconds: original.delayBetweenSendsSeconds,
        timezone: original.timezone,
        sendingDays: (original.sendingDays as any) ?? ["Mon", "Tue", "Wed", "Thu", "Fri"],
        sendingWindowStart: original.sendingWindowStart,
        sendingWindowEnd: original.sendingWindowEnd,
        stopOnReply: original.stopOnReply,
        openTracking: original.openTracking,
        landingPageUrl: original.landingPageUrl,
        utmCampaign: original.utmCampaign ? `${original.utmCampaign}_copy` : null,
        sequences: {
          create: original.sequences.map(seq => ({
            name: `${seq.name} (Copy)`,
            description: seq.description,
            sequenceType: seq.sequenceType,
            status: 'active',
            stopOnReply: seq.stopOnReply,
            stopOnBounce: seq.stopOnBounce,
            stopOnUnsubscribe: seq.stopOnUnsubscribe,
            stopOnRegistration: seq.stopOnRegistration,
            steps: {
              create: seq.steps.map(step => ({
                stepNumber: step.stepNumber,
                stepName: step.stepName,
                stepType: step.stepType,
                delayDays: step.delayDays,
                subjectTemplate: step.subjectTemplate,
                bodyTemplate: step.bodyTemplate,
                bodyHtmlTemplate: step.bodyHtmlTemplate,
                senderName: step.senderName,
                senderEmail: step.senderEmail,
                replyToEmail: step.replyToEmail,
                includeTracking: step.includeTracking,
                includeUnsubscribe: step.includeUnsubscribe,
                active: step.active
              }))
            }
          }))
        },
        auditLogs: {
          create: [{
            userId: userId || undefined,
            action: 'Campaign duplicated',
            details: `Duplicated from campaign "${original.name}" (${original.id})`
          }]
        }
      },
      include: {
        sequences: {
          include: { steps: true }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Campaign duplicated successfully',
      campaign: newCampaign
    });
  } catch (error: any) {
    console.error('Error duplicating campaign:', error);
    res.status(500).json({ error: error?.message || 'Failed to duplicate campaign' });
  }
};

export const createCampaign = composeCampaign; // Fallback

export const updateCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const campaignId = String(id);
    const {
      name, description, campaignCode, campaignType,
      listId,
      senderMailboxes, replyToEmail,
      timezone, sendingDays, sendingWindowStart, sendingWindowEnd,
      dailySendLimit, hourlySendLimit, delayBetweenSendsSeconds,
      stopOnReply, openTracking,
      sequenceSteps
    } = req.body;

    const existing = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        sequences: {
          include: { steps: { orderBy: { stepNumber: 'asc' } } }
        }
      }
    });

    if (!existing) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    await prisma.$transaction(async (tx) => {
      // 1. Update Campaign parameters
      const campaignUpdateData: any = {};
      if (name !== undefined) campaignUpdateData.name = name;
      if (description !== undefined) campaignUpdateData.description = description;
      if (campaignCode !== undefined) campaignUpdateData.campaignCode = campaignCode;
      if (campaignType !== undefined) campaignUpdateData.campaignType = campaignType;
      if (listId !== undefined) campaignUpdateData.listId = listId || null;
      if (senderMailboxes !== undefined) campaignUpdateData.senderMailboxes = senderMailboxes;
      if (replyToEmail !== undefined) campaignUpdateData.replyToEmail = replyToEmail;
      if (timezone !== undefined) campaignUpdateData.timezone = timezone;
      if (sendingDays !== undefined) campaignUpdateData.sendingDays = sendingDays;
      if (sendingWindowStart !== undefined) campaignUpdateData.sendingWindowStart = sendingWindowStart;
      if (sendingWindowEnd !== undefined) campaignUpdateData.sendingWindowEnd = sendingWindowEnd;
      if (dailySendLimit !== undefined) campaignUpdateData.dailySendLimit = Number(dailySendLimit);
      if (hourlySendLimit !== undefined) campaignUpdateData.hourlySendLimit = Number(hourlySendLimit);
      if (delayBetweenSendsSeconds !== undefined) campaignUpdateData.delayBetweenSendsSeconds = Number(delayBetweenSendsSeconds);
      if (stopOnReply !== undefined) campaignUpdateData.stopOnReply = stopOnReply;
      if (openTracking !== undefined) campaignUpdateData.openTracking = openTracking;

      if (Object.keys(campaignUpdateData).length > 0) {
        await tx.campaign.update({
          where: { id: campaignId },
          data: campaignUpdateData
        });
      }

      // 2. Update sequence steps if provided
      if (Array.isArray(sequenceSteps) && sequenceSteps.length > 0) {
        let sequenceId: string | undefined = existing.sequences[0]?.id;
        if (!sequenceId) {
          const newSeq = await tx.sequence.create({
            data: {
              campaignId,
              name: 'Primary Sequence'
            }
          });
          sequenceId = newSeq.id;
        }

        // Delete existing sequence steps and recreate in transaction to maintain exact order
        await tx.sequenceStep.deleteMany({
          where: { sequenceId }
        });

        await tx.sequenceStep.createMany({
          data: sequenceSteps.map((step: any, idx: number) => ({
            sequenceId,
            stepNumber: step.stepNumber ? Number(step.stepNumber) : idx + 1,
            stepType: step.type || step.stepType || 'email',
            delayDays: Number(step.delayDays ?? (idx === 0 ? 0 : 1)),
            subjectTemplate: step.subject || step.subjectTemplate || '',
            bodyTemplate: step.body || step.bodyTemplate || '',
            bodyHtmlTemplate: step.bodyHtml || step.bodyHtmlTemplate || null,
          }))
        });
      }

      // 3. Create Audit Log
      await tx.auditLog.create({
        data: {
          campaignId,
          action: 'Campaign updated',
          details: 'Campaign settings and sequence steps were updated from admin dashboard.'
        }
      });
    });

    const updated = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        list: true,
        sequences: {
          include: {
            steps: { orderBy: { stepNumber: 'asc' } }
          }
        },
        _count: {
          select: { enrollments: true }
        }
      }
    });

    res.status(200).json(updated);
  } catch (error: any) {
    console.error('Error updating campaign:', error);
    res.status(500).json({ error: error?.message || 'Failed to update campaign' });
  }
};

export const updateCampaignSteps = async (req: Request, res: Response): Promise<void> => {
  return updateCampaign(req, res);
};
// Replaced updateEnrollmentStatus

export const enrollLeads = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { contactIds } = req.body;
    
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      res.status(400).json({ error: 'No contact IDs provided' });
      return;
    }

    const campaign = await prisma.campaign.findUnique({ where: { id: String(id) } });
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const sequence = await prisma.sequence.findFirst({
      where: { campaignId: String(id) },
      orderBy: { createdAt: 'asc' }
    });
    
    if (!sequence) {
      res.status(400).json({ error: 'Campaign has no sequence to enroll into' });
      return;
    }

    await prisma.enrollment.createMany({
      data: contactIds.map(contactId => ({
        campaignId: String(id),
        sequenceId: sequence.id,
        contactId,
        status: 'active'
      })),
      skipDuplicates: true
    });
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error enrolling leads:', error);
    res.status(500).json({ error: 'Failed to enroll leads' });
  }
};
export const generateLeadDraft = async (req: Request, res: Response): Promise<void> => { res.status(200).json({}); };
export const getCampaignLeads = async (req: Request, res: Response): Promise<void> => { 
  try {
    const { id } = req.params;
    const filter = String(req.query.filter || 'ALL');
    const { AnalyticsService } = await import('../services/analyticsService');
    const contacts = await AnalyticsService.getCampaignContactEngagement(String(id), filter);
    res.status(200).json(contacts);
  } catch (error) {
    console.error('Error fetching enrollments:', error);
    res.status(500).json({ error: 'Failed to fetch enrollments' });
  }
};

// Phase 6: Manual Enrollment Controls
export const updateEnrollmentStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id, enrollmentId } = req.params;
    const { action, reason } = req.body; // action: 'pause', 'resume', 'stop'

    const enrollment = await prisma.enrollment.findUnique({ where: { id: String(enrollmentId) } });
    if (!enrollment) {
      res.status(404).json({ error: 'Enrollment not found' });
      return;
    }

    let updateData: any = {};
    const now = new Date();

    if (action === 'pause') {
      updateData = { status: 'paused', pausedAt: now, pauseReason: reason || 'MANUALLY_PAUSED' };
    } else if (action === 'resume') {
      updateData = { status: 'active', pausedAt: null, pauseReason: null };
      if (!enrollment.nextSendAt) updateData.nextSendAt = now;
    } else if (action === 'stop') {
      updateData = { status: 'completed', stoppedAt: now, stopReason: reason || 'MANUALLY_STOPPED', nextSendAt: null };
    } else {
      res.status(400).json({ error: 'Invalid action' });
      return;
    }

    const updated = await prisma.enrollment.update({
      where: { id: String(enrollmentId) },
      data: updateData
    });

    res.status(200).json(updated);
  } catch (error) {
    console.error('Error updating enrollment:', error);
    res.status(500).json({ error: 'Failed to update enrollment' });
  }
};

// Phase 5: MVP Audit Logs
export const getCampaignAuditLogs = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const logs = await prisma.auditLog.findMany({
      where: { campaignId: String(id) },
      orderBy: { createdAt: 'desc' }
    });
    res.status(200).json(logs);
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
};

// Phase 5: MVP Eligibility Preview
export const getEligibilityPreview = async (req: Request, res: Response): Promise<void> => {
  try {
    const { listId, rules } = req.query;
    const workspace = await getWorkspace();
    
    let eligibleContactIds: string[] = [];
    
    if (rules) {
      // Dynamic rules parsing
      let parsedRules: any = {};
      try {
        parsedRules = JSON.parse(String(rules));
      } catch (e) {}
      
      let whereClause: any = { workspaceId: workspace.id };
      if (parsedRules.city) whereClause.city = { contains: parsedRules.city, mode: 'insensitive' };
      if (parsedRules.jobTitle) whereClause.jobTitle = { contains: parsedRules.jobTitle, mode: 'insensitive' };
      if (parsedRules.industry) {
        whereClause.organization = { industry: { contains: parsedRules.industry, mode: 'insensitive' } };
      }
      
      const contacts = await prisma.contact.findMany({
        where: whereClause,
        select: { id: true }
      });
      
      eligibleContactIds = contacts.map(c => c.id);
    } else if (listId) {
      // Static list
      const members = await prisma.listMember.findMany({
        where: { listId: String(listId) },
        select: { contactId: true }
      });
      eligibleContactIds = members.map(m => m.contactId);
    }
    
    const totalContacts = eligibleContactIds.length;
    
    res.status(200).json({
      totalContacts,
      eligibleContacts: totalContacts,
      suppressed: 0,
      alreadyActive: 0
    });
  } catch (error) {
    console.error('Error fetching eligibility:', error);
    res.status(500).json({ error: 'Failed to calculate eligibility' });
  }
};

export const deleteCampaign = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const campaignId = String(id);

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId }
    });

    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    // Safely delete related records in proper topological order
    await prisma.$transaction(async (tx) => {
      // 1. Unlink emailMessageId in conversation messages
      const emailMessages = await tx.emailMessage.findMany({
        where: { campaignId },
        select: { id: true }
      });
      const emailMessageIds = emailMessages.map(m => m.id);

      if (emailMessageIds.length > 0) {
        await tx.conversationMessage.updateMany({
          where: { emailMessageId: { in: emailMessageIds } },
          data: { emailMessageId: null }
        });
      }

      // 2. Unlink conversations attached to this campaign
      await tx.conversation.updateMany({
        where: { campaignId },
        data: { campaignId: null, sequenceId: null, enrollmentId: null }
      });

      // 3. Delete email events
      await tx.emailEvent.deleteMany({
        where: {
          OR: [
            { campaignId },
            ...(emailMessageIds.length > 0 ? [{ emailMessageId: { in: emailMessageIds } }] : [])
          ]
        }
      });

      // 4. Delete email messages
      await tx.emailMessage.deleteMany({
        where: { campaignId }
      });

      // 5. Delete conversions
      await tx.conversion.deleteMany({
        where: { campaignId }
      });

      // 6. Delete enrollments
      await tx.enrollment.deleteMany({
        where: { campaignId }
      });

      // 7. Delete sequence steps and sequences
      const sequences = await tx.sequence.findMany({
        where: { campaignId },
        select: { id: true }
      });
      const sequenceIds = sequences.map(s => s.id);

      if (sequenceIds.length > 0) {
        await tx.sequenceStep.deleteMany({
          where: { sequenceId: { in: sequenceIds } }
        });
        await tx.sequence.deleteMany({
          where: { id: { in: sequenceIds } }
        });
      }

      // 8. Delete audit logs
      await tx.auditLog.deleteMany({
        where: { campaignId }
      });

      // 9. Delete the campaign record itself
      await tx.campaign.delete({
        where: { id: campaignId }
      });
    });

    res.status(200).json({ success: true, message: 'Campaign deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting campaign:', error);
    res.status(500).json({ error: error?.message || 'Failed to delete campaign' });
  }
};
