import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { OwnershipGuard } from '../utils/ownershipGuard';

const prisma = new PrismaClient();

// Setup workspace for user if not exists
async function getWorkspace(userId?: string) {
  let workspace = userId
    ? await prisma.workspace.findFirst({ where: { userId } })
    : await prisma.workspace.findFirst();
  if (!workspace) {
    workspace = await prisma.workspace.findFirst();
  }
  if (!workspace) {
    const user = await prisma.user.create({
      data: { email: 'admin@tripgain.com', name: 'Admin' }
    });
    workspace = await prisma.workspace.create({
      data: { name: 'TripGain', userId: user.id }
    });
  }
  return workspace;
}

export const getLists = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { search } = req.query;
    
    let whereClause: any = {
      userId: user.userId
    };

    if (search && typeof search === 'string') {
      whereClause.name = { contains: search, mode: 'insensitive' };
    }

    const lists = await prisma.list.findMany({
      where: whereClause,
      include: {
        _count: {
          select: { members: true, campaigns: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    const formatted = lists.map(list => ({
      id: list.id,
      name: list.name,
      contacts: list._count.members,
      type: list.listType,
      status: 'Active'
    }));
    
    // Add a default Suppression List for current user
    const suppressionCount = await prisma.suppressionList.count({
      where: { userId: user.userId }
    });

    formatted.push({
      id: 'suppression-1',
      name: 'Suppression List',
      contacts: suppressionCount,
      type: 'system',
      status: 'Active'
    });
    
    res.status(200).json(formatted);
  } catch (error) {
    console.error('Error fetching lists:', error);
    res.status(500).json({ error: 'Failed to fetch lists' });
  }
};

export const createList = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { name, listType, description, rules } = req.body;
    const workspace = await getWorkspace(user.userId);
    
    const list = await prisma.list.create({
      data: {
        name,
        listType: listType || 'static',
        description,
        rules: rules ? rules : undefined,
        workspaceId: workspace.id,
        userId: user.userId
      }
    });
    
    res.status(201).json(list);
  } catch (error) {
    console.error('Error creating list:', error);
    res.status(500).json({ error: 'Failed to create list' });
  }
};

export const getListById = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { id } = req.params;
    
    if (id === 'suppression-1') {
      const suppressions = await prisma.suppressionList.findMany({
        where: { userId: user.userId },
        orderBy: { suppressedAt: 'desc' }
      });
      res.status(200).json({
        id: 'suppression-1',
        name: 'Suppression List',
        listType: 'system',
        contacts: suppressions.map(s => ({
          id: s.id,
          email: s.email,
          fullName: s.email,
          status: 'Suppressed',
          reason: s.reason,
          createdAt: s.suppressedAt
        }))
      });
      return;
    }
    
    const list = await OwnershipGuard.assertList(req, res, String(id));
    if (!list) return;
    
    let resolvedContacts: any[] = [];
    
    if (list.listType === 'dynamic' && list.rules) {
      // Execute dynamic rules scoped strictly to user's contacts
      const rules = list.rules as any;
      let whereClause: any = { userId: user.userId };
      
      if (rules.city) whereClause.city = { contains: rules.city, mode: 'insensitive' };
      if (rules.jobTitle) whereClause.jobTitle = { contains: rules.jobTitle, mode: 'insensitive' };
      
      if (rules.industry) {
        whereClause.organization = {
          industry: { contains: rules.industry, mode: 'insensitive' }
        };
      }
      
      resolvedContacts = await prisma.contact.findMany({
        where: whereClause,
        include: {
          organization: true,
          emails: true,
          listMemberships: { include: { list: true } }
        },
        orderBy: { createdAt: 'desc' }
      });
      
    } else {
      // Static list - fetch members
      const members = await prisma.listMember.findMany({
        where: { listId: list.id },
        include: {
          contact: {
            include: {
              organization: true,
              emails: true,
              listMemberships: { include: { list: true } }
            }
          }
        },
        orderBy: { addedAt: 'desc' }
      });
      
      resolvedContacts = members.map(m => m.contact).filter(Boolean);
    }
    
    const formattedContacts = resolvedContacts.map(c => ({
      id: c.id,
      fullName: c.fullName,
      email: c.emails?.find((e: any) => e.isPrimary)?.email || c.emails?.[0]?.email,
      jobTitle: c.jobTitle,
      companyName: c.organization?.name,
      industry: c.organization?.industry,
      status: c.leadStatus || 'Cold',
      lists: c.listMemberships?.map((m: any) => m.list?.name) || [],
      personalizedLine: c.personalizedLine,
      personalizationStatus: c.personalizationStatus,
      personalizationSource: c.personalizationSource,
      personalizationConfidence: c.personalizationConfidence,
      personalizationEvidence: c.personalizationEvidence,
      personalizationGeneratedAt: c.personalizationGeneratedAt,
      createdAt: c.createdAt
    }));
    
    res.status(200).json({
      ...list,
      contacts: formattedContacts
    });
    
  } catch (error) {
    console.error('Error fetching list by id:', error);
    res.status(500).json({ error: 'Failed to fetch list' });
  }
};

export const deleteList = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    
    // Prevent deletion of system lists
    if (id === 'suppression-1') {
      res.status(403).json({ error: 'Cannot delete system lists' });
      return;
    }

    const list = await OwnershipGuard.assertList(req, res, String(id));
    if (!list) return;
    
    // Explicitly delete related records since onDelete: Cascade is missing for List relations
    await prisma.$transaction([
      prisma.campaign.updateMany({
        where: { listId: list.id },
        data: { listId: null }
      }),
      prisma.listMember.deleteMany({
        where: { listId: list.id }
      }),
      prisma.list.delete({
        where: { id: list.id }
      })
    ]);
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting list:', error);
    res.status(500).json({ error: 'Failed to delete list' });
  }
};

export const addMembersToList = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { id } = req.params;
    const { contactIds } = req.body;
    
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      res.status(400).json({ error: 'No contact IDs provided' });
      return;
    }

    const list = await OwnershipGuard.assertList(req, res, String(id));
    if (!list) return;

    // Only static lists can have members manually added
    if (list.listType !== 'static') {
      res.status(400).json({ error: 'Cannot manually add members to dynamic lists' });
      return;
    }

    // Verify contactIds belong to current user
    const userContacts = await prisma.contact.findMany({
      where: {
        id: { in: contactIds },
        userId: user.userId
      },
      select: { id: true }
    });

    const validContactIds = userContacts.map(c => c.id);
    if (validContactIds.length === 0) {
      res.status(400).json({ error: 'No valid contacts owned by current user found' });
      return;
    }

    await prisma.listMember.createMany({
      data: validContactIds.map(contactId => ({
        listId: list.id,
        contactId: contactId,
        membershipStatus: 'active'
      })),
      skipDuplicates: true
    });
    
    res.status(200).json({ success: true, addedCount: validContactIds.length });
  } catch (error) {
    console.error('Error adding members to list:', error);
    res.status(500).json({ error: 'Failed to add members' });
  }
};

export const removeMembersFromList = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { contactIds } = req.body;
    
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      res.status(400).json({ error: 'No contact IDs provided' });
      return;
    }

    const list = await OwnershipGuard.assertList(req, res, String(id));
    if (!list) return;

    await prisma.listMember.deleteMany({
      where: {
        listId: list.id,
        contactId: { in: contactIds }
      }
    });
    
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove members from list' });
  }
};

export const updateList = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    
    const list = await OwnershipGuard.assertList(req, res, String(id));
    if (!list) return;

    const updated = await prisma.list.update({
      where: { id: list.id },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description })
      }
    });
    
    res.status(200).json(updated);
  } catch (error) {
    console.error('Error updating list:', error);
    res.status(500).json({ error: 'Failed to update list' });
  }
};

export const duplicateList = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { id } = req.params;
    
    const list = await OwnershipGuard.assertList(req, res, String(id));
    if (!list) return;

    const fullList = await prisma.list.findUnique({
      where: { id: list.id },
      include: { members: true }
    });
    
    if (!fullList) {
      res.status(404).json({ error: 'List not found' });
      return;
    }
    
    const duplicatedList = await prisma.list.create({
      data: {
        name: `${fullList.name} (Copy)`,
        listType: fullList.listType,
        description: fullList.description,
        workspaceId: fullList.workspaceId,
        userId: user.userId,
        members: {
          create: fullList.members.map(m => ({
            contactId: m.contactId,
            membershipStatus: m.membershipStatus
          }))
        }
      }
    });
    
    res.status(201).json(duplicatedList);
  } catch (error) {
    console.error('Error duplicating list:', error);
    res.status(500).json({ error: 'Failed to duplicate list' });
  }
};
