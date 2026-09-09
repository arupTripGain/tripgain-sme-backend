import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { OwnershipGuard } from '../utils/ownershipGuard';

const prisma = new PrismaClient();

// Setup dummy workspace if not exists (for phase 2 before auth)
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

export const createContact = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { firstName, lastName, jobTitle, email, companyName, domain, industry, city, linkedinUrl, personalizedLine, personalizationTrigger, companySize, companyPhone } = req.body;
    const workspace = await getWorkspace();

    // 1. Handle Organization
    let organization = null;
    if (companyName || domain) {
      if (domain) {
        organization = await prisma.organization.findUnique({
          where: { workspaceId_domain: { workspaceId: workspace.id, domain } }
        });
      }
      
      if (!organization) {
        organization = await prisma.organization.create({
          data: {
            workspaceId: workspace.id,
            name: companyName || 'Unknown Company',
            domain: domain || null,
            industry: industry || null,
            employeeSize: companySize || null,
            phone: companyPhone || null,
            city: city || null
          }
        });
      }
    }

    // 2. Create Contact with authoritative userId
    const contact = await prisma.contact.create({
      data: {
        workspaceId: workspace.id,
        userId: user.userId,
        organizationId: organization?.id || null,
        firstName,
        lastName,
        fullName: `${firstName || ''} ${lastName || ''}`.trim(),
        jobTitle,
        city,
        linkedinUrl,
        personalizedLine,
        personalizationTrigger,
        emails: {
          create: [{
            email: email,
            normalizedEmail: email.toLowerCase().trim(),
            isPrimary: true
          }]
        }
      },
      include: {
        organization: true,
        emails: true
      }
    });

    res.status(201).json(contact);
  } catch (error) {
    console.error('Error creating contact:', error);
    res.status(500).json({ error: 'Failed to create contact' });
  }
};

export const getContacts = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { search } = req.query;
    
    let whereClause: any = {
      userId: user.userId
    };

    if (search && typeof search === 'string') {
      const s = search;
      whereClause.AND = [
        {
          OR: [
            { fullName: { contains: s, mode: 'insensitive' } },
            { firstName: { contains: s, mode: 'insensitive' } },
            { lastName: { contains: s, mode: 'insensitive' } },
            { jobTitle: { contains: s, mode: 'insensitive' } },
            { city: { contains: s, mode: 'insensitive' } },
            { emails: { some: { email: { contains: s, mode: 'insensitive' } } } },
            { organization: { name: { contains: s, mode: 'insensitive' } } },
            { organization: { industry: { contains: s, mode: 'insensitive' } } },
          ]
        }
      ];
    }

    const contacts = await prisma.contact.findMany({
      where: whereClause,
      include: {
        organization: true,
        emails: true,
        listMemberships: {
          include: { list: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    // Flatten output slightly for easier table rendering
    const formatted = contacts.map(c => ({
      id: c.id,
      fullName: c.fullName,
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.emails.find(e => e.isPrimary)?.email || c.emails[0]?.email,
      jobTitle: c.jobTitle,
      city: c.city,
      linkedinUrl: c.linkedinUrl,
      personalizedLine: c.personalizedLine,
      personalizationTrigger: c.personalizationTrigger,
      companyName: c.organization?.name,
      website: c.organization?.domain,
      industry: c.organization?.industry,
      companySize: c.organization?.employeeSize,
      companyPhone: c.organization?.phone,
      personalization: c.personalizedLine,
      personalizationStatus: c.personalizationStatus || (c.personalizedLine ? 'GENERATED' : 'PENDING'),
      personalizationSource: c.personalizationSource || (c.personalizedLine ? 'AI_RESEARCH' : null),
      personalizationGeneratedAt: c.personalizationGeneratedAt,
      personalizationUpdatedAt: c.personalizationUpdatedAt,
      personalizationConfidence: c.personalizationConfidence || (c.personalizedLine ? 'HIGH' : null),
      status: c.leadStatus || 'Cold',
      lists: c.listMemberships.map(m => m.list.name),
      createdAt: c.createdAt
    }));

    res.status(200).json(formatted);
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
};

export const getContactById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const contact = await OwnershipGuard.assertContact(req, res, String(id));
    if (!contact) return;

    const fullContact = await prisma.contact.findUnique({
      where: { id: contact.id },
      include: {
        organization: true,
        emails: true,
        listMemberships: {
          include: { list: true }
        },
        enrollments: {
          include: { 
            campaign: true,
            messages: {
              include: { events: true }
            }
          }
        }
      }
    });
    
    res.status(200).json(fullContact);
  } catch (error) {
    console.error('Error fetching contact:', error);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
};

export const bulkImportContacts = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { contacts, listId, newListName } = req.body;
    const workspace = await getWorkspace();
    
    let targetListId = listId;
    
    // Create new list if requested
    if (newListName && !targetListId) {
      const newList = await prisma.list.create({
        data: {
          workspaceId: workspace.id,
          userId: user.userId,
          name: newListName,
          listType: 'static'
        }
      });
      targetListId = newList.id;
    }
    
    let stats = {
      total: contacts.length,
      new: 0,
      updated: 0,
      duplicates: 0,
      invalid: 0
    };
    
    // For large imports in production, use prisma.$transaction or a message queue.
    // For this prototype, we'll process sequentially.
    for (const row of contacts) {
      const email = row.email?.trim()?.toLowerCase();
      
      if (!email || !email.includes('@')) {
        stats.invalid++;
        continue;
      }
      
      // 1. Organization mapping
      let orgId = null;
      let domain = row.domain?.trim()?.toLowerCase();
      const companyName = row.companyName?.trim();
      
      if (!domain && email) {
        const parts = email.split('@');
        if (parts.length === 2 && !['gmail.com', 'yahoo.com', 'hotmail.com'].includes(parts[1])) {
          domain = parts[1];
        }
      }
      
      if (domain || companyName) {
        let organization = null;
        if (domain) {
          organization = await prisma.organization.findUnique({
            where: { workspaceId_domain: { workspaceId: workspace.id, domain } }
          });
        }
        
        if (!organization) {
          organization = await prisma.organization.create({
            data: {
              workspaceId: workspace.id,
              name: companyName || domain || 'Unknown',
              domain: domain || null,
              industry: row.industry || null,
              employeeSize: row.companySize || null,
              phone: row.companyPhone || null
            }
          });
        }
        orgId = organization.id;
      }
      
      // 2. Check existing contact via Email strictly for this user
      const existingEmail = await prisma.contactEmail.findFirst({
        where: { 
          normalizedEmail: email,
          contact: { userId: user.userId }
        },
        include: { contact: true }
      });
      
      let contactId = null;
      
      if (existingEmail) {
        contactId = existingEmail.contactId;
        
        // Check if already in list
        if (targetListId) {
          const existingMember = await prisma.listMember.findUnique({
            where: { listId_contactId: { listId: targetListId, contactId } }
          });
          
          if (existingMember) {
            stats.duplicates++;
          } else {
            // Add to list
            await prisma.listMember.create({
              data: { listId: targetListId, contactId }
            });
            stats.updated++;
          }
        } else {
          stats.duplicates++;
        }
        
      } else {
        // Create new contact scoped to user.userId
        const newContact = await prisma.contact.create({
          data: {
            workspaceId: workspace.id,
            userId: user.userId,
            organizationId: orgId,
            firstName: row.firstName || null,
            lastName: row.lastName || null,
            fullName: `${row.firstName || ''} ${row.lastName || ''}`.trim() || null,
            jobTitle: row.jobTitle || null,
            linkedinUrl: row.linkedinUrl || null,
            city: row.city || null,
            personalizedLine: row.personalizedLine || null,
            personalizationTrigger: row.personalizationTrigger || null,
            emails: {
              create: [{
                email: row.email,
                normalizedEmail: email,
                isPrimary: true
              }]
            }
          }
        });
        
        contactId = newContact.id;
        stats.new++;
        
        if (targetListId) {
          await prisma.listMember.create({
            data: { listId: targetListId, contactId }
          });
        }
      }
    }
    
    res.status(200).json(stats);
  } catch (error) {
    console.error('Bulk import error:', error);
    res.status(500).json({ error: 'Failed to import contacts' });
  }
};

export const deleteContact = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const contact = await OwnershipGuard.assertContact(req, res, id);
    if (!contact) return;
    
    // Explicitly delete related records since onDelete: Cascade is missing
    await prisma.$transaction([
      prisma.contactEmail.deleteMany({ where: { contactId: id } }),
      prisma.listMember.deleteMany({ where: { contactId: id } }),
      prisma.enrollment.deleteMany({ where: { contactId: id } }),
      prisma.emailMessage.deleteMany({ where: { contactId: id } }),
      prisma.emailEvent.deleteMany({ where: { contactId: id } }),
      prisma.conversationAction.deleteMany({ where: { contactId: id } }),
      prisma.conversation.deleteMany({ where: { contactId: id } }),
      prisma.contact.delete({ where: { id } })
    ]);
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting contact:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
};

export const bulkDeleteContacts = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { ids } = req.body;
    
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'No contact IDs provided' });
      return;
    }
    
    // Filter only contacts belonging to this user
    const ownedContacts = await prisma.contact.findMany({
      where: { id: { in: ids }, userId: user.userId },
      select: { id: true }
    });
    const ownedIds = ownedContacts.map(c => c.id);

    if (ownedIds.length === 0) {
      res.status(200).json({ success: true, count: 0 });
      return;
    }

    await prisma.$transaction([
      prisma.contactEmail.deleteMany({ where: { contactId: { in: ownedIds } } }),
      prisma.listMember.deleteMany({ where: { contactId: { in: ownedIds } } }),
      prisma.enrollment.deleteMany({ where: { contactId: { in: ownedIds } } }),
      prisma.emailMessage.deleteMany({ where: { contactId: { in: ownedIds } } }),
      prisma.emailEvent.deleteMany({ where: { contactId: { in: ownedIds } } }),
      prisma.conversationAction.deleteMany({ where: { contactId: { in: ownedIds } } }),
      prisma.conversation.deleteMany({ where: { contactId: { in: ownedIds } } }),
      prisma.contact.deleteMany({ where: { id: { in: ownedIds } } })
    ]);
    
    res.status(200).json({ success: true, count: ownedIds.length });
  } catch (error) {
    console.error('Error bulk deleting contacts:', error);
    res.status(500).json({ error: 'Failed to bulk delete contacts' });
  }
};

export const updateContact = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const existing = await OwnershipGuard.assertContact(req, res, id);
    if (!existing) return;

    const { firstName, lastName, jobTitle, city, companyName, industry, personalizedLine, personalizationTrigger, email, leadStatus } = req.body;
    
    // First, update the contact's main data
    const dataToUpdate: any = {};
    if (firstName !== undefined) dataToUpdate.firstName = firstName;
    if (lastName !== undefined) dataToUpdate.lastName = lastName;
    if (firstName || lastName) dataToUpdate.fullName = `${firstName || ''} ${lastName || ''}`.trim();
    if (jobTitle !== undefined) dataToUpdate.jobTitle = jobTitle;
    if (city !== undefined) dataToUpdate.city = city;
    if (personalizedLine !== undefined) dataToUpdate.personalizedLine = personalizedLine;
    if (personalizationTrigger !== undefined) dataToUpdate.personalizationTrigger = personalizationTrigger;
    if (leadStatus !== undefined) dataToUpdate.leadStatus = leadStatus;

    const contact = await prisma.contact.update({
      where: { id },
      data: dataToUpdate
    });

    // Handle Organization update if provided
    if (companyName || industry) {
      if (contact.organizationId) {
        await prisma.organization.update({
          where: { id: contact.organizationId },
          data: {
            name: companyName !== undefined ? companyName : undefined,
            industry: industry !== undefined ? industry : undefined,
          }
        });
      } else if (companyName) {
        const newOrg = await prisma.organization.create({
          data: {
            workspaceId: contact.workspaceId,
            name: companyName,
            industry: industry || null
          }
        });
        await prisma.contact.update({
          where: { id },
          data: { organizationId: newOrg.id }
        });
      }
    }

    // Handle Primary Email update if provided
    if (email) {
      const existingEmail = await prisma.contactEmail.findFirst({
        where: { contactId: id, isPrimary: true }
      });
      if (existingEmail) {
        await prisma.contactEmail.update({
          where: { id: existingEmail.id },
          data: { 
            email: email, 
            normalizedEmail: email.toLowerCase().trim() 
          }
        });
      } else {
        await prisma.contactEmail.create({
          data: {
            contactId: id,
            email: email,
            normalizedEmail: email.toLowerCase().trim(),
            isPrimary: true
          }
        });
      }
    }
    
    // Fetch the updated contact to return
    const updatedContact = await prisma.contact.findUnique({
      where: { id },
      include: {
        organization: true,
        emails: true
      }
    });
    
    res.status(200).json(updatedContact);
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
};

export const exportContacts = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { contactIds } = req.body;
    
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      res.status(400).json({ error: 'No contact IDs provided' });
      return;
    }

    const contacts = await prisma.contact.findMany({
      where: { 
        id: { in: contactIds },
        userId: user.userId
      },
      include: {
        organization: true,
        emails: true,
      }
    });

    if (contacts.length === 0) {
      res.status(404).json({ error: 'No contacts found' });
      return;
    }

    // Build CSV
    const headers = ['First Name', 'Last Name', 'Full Name', 'Email', 'Job Title', 'Company', 'Industry', 'City', 'Status'];
    const rows = contacts.map(c => [
      c.firstName || '',
      c.lastName || '',
      c.fullName || '',
      c.emails.find(e => e.isPrimary)?.email || c.emails[0]?.email || '',
      c.jobTitle || '',
      c.organization?.name || '',
      c.organization?.industry || '',
      c.city || '',
      c.leadStatus || 'Cold'
    ]);

    const escapeCsv = (str: string) => `"${str.replace(/"/g, '""')}"`;
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(escapeCsv).join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=contacts_export.csv');
    res.status(200).send(csvContent);
  } catch (error) {
    console.error('Error exporting contacts:', error);
    res.status(500).json({ error: 'Failed to export contacts' });
  }
};
