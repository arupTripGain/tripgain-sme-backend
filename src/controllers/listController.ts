import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Setup dummy workspace if not exists
async function getWorkspace() {
  let workspace = await prisma.workspace.findFirst();
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
    const { search } = req.query;
    
    let whereClause: any = {};
    if (search && typeof search === 'string') {
      whereClause = {
        name: { contains: search, mode: 'insensitive' }
      };
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
      status: 'Active' // We can expand this later
    }));
    
    // Add a default Suppression List to match the spec mockup
    formatted.push({
      id: 'suppression-1',
      name: 'Suppression List',
      contacts: 0,
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
    const { name, listType, description, rules } = req.body;
    const workspace = await getWorkspace();
    
    const list = await prisma.list.create({
      data: {
        name,
        listType: listType || 'static',
        description,
        rules: rules ? rules : undefined,
        workspaceId: workspace.id
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
    const { id } = req.params;
    
    if (id === 'suppression-1') {
      res.status(200).json({
        id: 'suppression-1',
        name: 'Suppression List',
        listType: 'system',
        contacts: []
      });
      return;
    }
    
    const list = await prisma.list.findUnique({
      where: { id: String(id) }
    });
    
    if (!list) {
      res.status(404).json({ error: 'List not found' });
      return;
    }
    
    let resolvedContacts: any[] = [];
    
    if (list.listType === 'dynamic' && list.rules) {
      // Execute dynamic rules
      const rules = list.rules as any;
      let whereClause: any = { workspaceId: list.workspaceId };
      
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
      
      resolvedContacts = members.map(m => m.contact);
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
    
    // Explicitly delete related records since onDelete: Cascade is missing for List relations
    // First, remove listId from campaigns to prevent constraint violation
    await prisma.$transaction([
      prisma.campaign.updateMany({
        where: { listId: String(id) },
        data: { listId: null }
      }),
      prisma.listMember.deleteMany({
        where: { listId: String(id) }
      }),
      prisma.list.delete({
        where: { id: String(id) }
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
    const { id } = req.params;
    const { contactIds } = req.body;
    
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      res.status(400).json({ error: 'No contact IDs provided' });
      return;
    }

    const list = await prisma.list.findUnique({ where: { id: String(id) } });
    if (!list) {
      res.status(404).json({ error: 'List not found' });
      return;
    }

    // Only static lists can have members manually added
    if (list.listType !== 'static') {
      res.status(400).json({ error: 'Cannot manually add members to dynamic lists' });
      return;
    }

    // Insert only if they don't already exist (using Prisma's createMany with skipDuplicates if supported, or individual creates)
    // Prisma createMany skipDuplicates is supported on Postgres
    await prisma.listMember.createMany({
      data: contactIds.map(contactId => ({
        listId: String(id),
        contactId: contactId,
        membershipStatus: 'active'
      })),
      skipDuplicates: true
    });
    
    res.status(200).json({ success: true });
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

    await prisma.listMember.deleteMany({
      where: {
        listId: String(id),
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
    
    const updated = await prisma.list.update({
      where: { id: String(id) },
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
    const { id } = req.params;
    
    const list = await prisma.list.findUnique({
      where: { id: String(id) },
      include: { members: true }
    });
    
    if (!list) {
      res.status(404).json({ error: 'List not found' });
      return;
    }
    
    const duplicatedList = await prisma.list.create({
      data: {
        name: `${list.name} (Copy)`,
        listType: list.listType,
        description: list.description,
        workspaceId: list.workspaceId,
        members: {
          create: list.members.map(m => ({
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
