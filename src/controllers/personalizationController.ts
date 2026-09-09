import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { PersonalizationService } from '../services/personalizationService';
import { PersonalizationQueue } from '../services/personalizationQueue';
import { OwnershipGuard } from '../utils/ownershipGuard';

const prisma = new PrismaClient();

async function getWorkspace(userId?: string) {
  let workspace = userId
    ? await prisma.workspace.findFirst({ where: { userId } })
    : await prisma.workspace.findFirst();
  if (!workspace) {
    workspace = await prisma.workspace.findFirst();
  }
  if (!workspace) {
    let user = await prisma.user.findFirst();
    if (!user) {
      user = await prisma.user.create({
        data: { email: 'admin@tripgain.com', name: 'Admin' }
      });
    }
    workspace = await prisma.workspace.create({
      data: { name: 'TripGain', userId: user.id }
    });
  }
  return workspace;
}

/**
 * Generate or regenerate personalization for a single contact.
 */
export const personalizeContact = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const { force } = req.body || {};

    if (!id) {
      res.status(400).json({ error: 'Contact ID is required' });
      return;
    }

    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const contact = await OwnershipGuard.assertContact(req, res, id);
    if (!contact) return;

    const result = await PersonalizationService.generateForContact(contact.id, !!force, user.userId);
    if (!result.success && result.code) {
      if (result.code === 'AI_PROVIDER_NOT_CONFIGURED') {
        res.status(400).json({ error: result.reason, code: result.code });
        return;
      }
      if (result.code === 'AI_USAGE_LIMIT_REACHED') {
        res.status(429).json({ error: result.reason, code: result.code });
        return;
      }
    }
    res.status(200).json(result);
  } catch (error: any) {
    console.error('[PersonalizationController] Error in personalizeContact:', error);
    res.status(500).json({ error: 'Failed to generate personalization', detail: error?.message });
  }
};

/**
 * Save manual edits to personalization. Sets source = MANUAL to prevent automatic overwriting.
 */
export const editPersonalization = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const { personalization } = req.body;

    if (!id) {
      res.status(400).json({ error: 'Contact ID is required' });
      return;
    }

    const contact = await OwnershipGuard.assertContact(req, res, id);
    if (!contact) return;

    if (personalization === undefined) {
      res.status(400).json({ error: 'Personalization text is required' });
      return;
    }

    const updated = await PersonalizationService.updateManualPersonalization(contact.id, personalization);
    res.status(200).json({
      success: true,
      personalization: updated.personalizedLine,
      status: updated.personalizationStatus,
      source: updated.personalizationSource,
      confidence: updated.personalizationConfidence,
      contact: updated
    });
  } catch (error: any) {
    console.error('[PersonalizationController] Error in editPersonalization:', error);
    res.status(500).json({ error: 'Failed to update personalization', detail: error?.message });
  }
};

/**
 * Start asynchronous bulk personalization generation.
 */
export const startBulkPersonalization = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const workspace = await getWorkspace(user.userId);
    const { contactIds, listId, onlyMissing, force } = req.body || {};

    let validContactIds = contactIds;
    if (Array.isArray(contactIds) && contactIds.length > 0) {
      const ownedContacts = await prisma.contact.findMany({
        where: { id: { in: contactIds }, userId: user.userId },
        select: { id: true }
      });
      validContactIds = ownedContacts.map(c => c.id);
      if (validContactIds.length === 0) {
        res.status(400).json({ error: 'No valid contacts owned by current user' });
        return;
      }
    }

    if (listId) {
      const list = await OwnershipGuard.assertList(req, res, String(listId));
      if (!list) return;
    }

    const job = await PersonalizationQueue.startBulkJob({
      workspaceId: workspace.id,
      userId: user.userId,
      contactIds: validContactIds,
      listId,
      onlyMissing: !!onlyMissing,
      force: !!force
    });

    res.status(200).json(job);
  } catch (error: any) {
    console.error('[PersonalizationController] Error in startBulkPersonalization:', error);
    res.status(500).json({ error: 'Failed to start bulk personalization', detail: error?.message });
  }
};

/**
 * Poll bulk job progress.
 */
export const getBulkJobStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const jobId = String(req.params.jobId);

    if (!jobId) {
      res.status(400).json({ error: 'Job ID is required' });
      return;
    }

    const job = await PersonalizationQueue.getJobStatus(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.status(200).json(job);
  } catch (error: any) {
    console.error('[PersonalizationController] Error in getBulkJobStatus:', error);
    res.status(500).json({ error: 'Failed to get job status', detail: error?.message });
  }
};

/**
 * Get personalization summary stats for a list.
 */
export const getListPersonalizationStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const id = String(req.params.id);

    const list = await OwnershipGuard.assertList(req, res, id);
    if (!list) return;

    let contactList: any[] = [];

    if (list.listType === 'dynamic' && list.rules) {
      const rules = list.rules as any;
      let whereClause: any = { userId: user.userId };
      if (rules.city) whereClause.city = { contains: rules.city, mode: 'insensitive' };
      if (rules.jobTitle) whereClause.jobTitle = { contains: rules.jobTitle, mode: 'insensitive' };
      if (rules.industry) {
        whereClause.organization = {
          industry: { contains: rules.industry, mode: 'insensitive' }
        };
      }
      contactList = await prisma.contact.findMany({
        where: whereClause,
        select: { personalizedLine: true, personalizationStatus: true }
      });
    } else {
      const members = await prisma.listMember.findMany({
        where: { 
          listId: list.id,
          contact: { userId: user.userId }
        },
        include: {
          contact: {
            select: { personalizedLine: true, personalizationStatus: true }
          }
        }
      });
      contactList = members.map(m => m.contact);
    }

    let total = contactList.length;
    let generated = 0;
    let missing = 0;
    let failed = 0;
    let generating = 0;

    for (const c of contactList) {
      if (!c) continue;
      const status = c.personalizationStatus;
      const hasLine = !!c.personalizedLine && c.personalizedLine.trim() !== '';

      if (status === 'GENERATING') {
        generating++;
      } else if (status === 'GENERATED' || hasLine) {
        generated++;
      } else if (status === 'FAILED' || status === 'NO_USEFUL_DATA') {
        failed++;
      } else {
        missing++;
      }
    }

    res.status(200).json({
      listId: id,
      total,
      generated,
      missing,
      failed,
      generating
    });
  } catch (error: any) {
    console.error('[PersonalizationController] Error in getListPersonalizationStats:', error);
    res.status(500).json({ error: 'Failed to get list personalization stats', detail: error?.message });
  }
};
