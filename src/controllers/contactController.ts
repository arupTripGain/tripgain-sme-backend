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
    
    if (!Array.isArray(contacts) || contacts.length === 0) {
      res.status(200).json({
        total: 0,
        new: 0,
        updated: 0,
        duplicates: 0,
        invalid: 0,
        listId: listId || null
      });
      return;
    }

    const workspace = await getWorkspace();
    
    let targetListId = listId || null;
    
    // Create new list if requested or find existing by same name to avoid duplicates
    if (newListName && typeof newListName === 'string' && newListName.trim() && !targetListId) {
      const trimmedListName = newListName.trim();
      const existingList = await prisma.list.findFirst({
        where: {
          workspaceId: workspace.id,
          userId: user.userId,
          name: trimmedListName
        }
      });

      if (existingList) {
        targetListId = existingList.id;
      } else {
        const newList = await prisma.list.create({
          data: {
            workspaceId: workspace.id,
            userId: user.userId,
            name: trimmedListName,
            listType: 'static'
          }
        });
        targetListId = newList.id;
      }
    }
    
    const stats = {
      total: contacts.length,
      new: 0,
      updated: 0,
      duplicates: 0,
      invalid: 0,
      listId: targetListId
    };

    // Step 1: Pre-process and validate email formats & deduplicate within this request batch
    interface ValidRowItem {
      cleanEmail: string;
      cleanDomain: string | null;
      companyName: string | null;
      raw: any;
    }

    const validItems: ValidRowItem[] = [];
    const seenEmailsInBatch = new Set<string>();

    for (const row of contacts) {
      if (!row || typeof row !== 'object') {
        stats.invalid++;
        continue;
      }

      const rawEmail = typeof row.email === 'string' ? row.email.trim() : '';
      const email = rawEmail.toLowerCase();
      
      // Basic email syntax validation
      if (!email || !email.includes('@') || !email.includes('.') || email.length > 254) {
        stats.invalid++;
        continue;
      }

      // Deduplicate duplicate rows inside the same CSV file
      if (seenEmailsInBatch.has(email)) {
        stats.duplicates++;
        continue;
      }
      seenEmailsInBatch.add(email);

      // Clean domain
      let domain = typeof row.domain === 'string' ? row.domain.trim().toLowerCase() : '';
      if (domain) {
        domain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim();
      }
      if (!domain && email) {
        const parts = email.split('@');
        if (parts.length === 2 && !['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'rediffmail.com'].includes(parts[1])) {
          domain = parts[1];
        }
      }

      const companyName = typeof row.companyName === 'string' && row.companyName.trim() ? row.companyName.trim() : null;

      validItems.push({
        cleanEmail: email,
        cleanDomain: domain || null,
        companyName,
        raw: row
      });
    }

    if (validItems.length === 0) {
      res.status(200).json(stats);
      return;
    }

    // Step 2: Batch query existing contacts for this user across all valid emails
    const existingContactEmails = await prisma.contactEmail.findMany({
      where: {
        normalizedEmail: { in: validItems.map(item => item.cleanEmail) },
        contact: { userId: user.userId }
      },
      select: {
        normalizedEmail: true,
        contactId: true
      }
    });

    const existingEmailToContactId = new Map<string, string>();
    for (const item of existingContactEmails) {
      existingEmailToContactId.set(item.normalizedEmail, item.contactId);
    }

    // Step 3: Batch query existing list memberships if target list is specified
    const existingMemberContactIds = new Set<string>();
    if (targetListId) {
      const existingMembers = await prisma.listMember.findMany({
        where: { listId: targetListId },
        select: { contactId: true }
      });
      for (const m of existingMembers) {
        existingMemberContactIds.add(m.contactId);
      }
    }

    // Step 4: Batch pre-fetch organizations by domain to avoid redundant queries
    const uniqueDomains = Array.from(new Set(validItems.map(i => i.cleanDomain).filter(Boolean))) as string[];
    const domainToOrgId = new Map<string, string>();

    if (uniqueDomains.length > 0) {
      const existingOrgs = await prisma.organization.findMany({
        where: {
          workspaceId: workspace.id,
          domain: { in: uniqueDomains }
        },
        select: { id: true, domain: true }
      });
      for (const org of existingOrgs) {
        if (org.domain) {
          domainToOrgId.set(org.domain.toLowerCase(), org.id);
        }
      }
    }

    // Safe helper to resolve or create organization without breaking contact import
    const getOrCreateOrg = async (domain: string | null, companyName: string | null, row: any): Promise<string | null> => {
      if (!domain && !companyName) return null;
      if (domain && domainToOrgId.has(domain)) {
        return domainToOrgId.get(domain)!;
      }

      try {
        let organization = null;
        if (domain) {
          organization = await prisma.organization.findUnique({
            where: { workspaceId_domain: { workspaceId: workspace.id, domain } }
          });
        }
        
        if (!organization && companyName) {
          organization = await prisma.organization.findFirst({
            where: { workspaceId: workspace.id, name: companyName }
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

        if (domain && organization?.id) {
          domainToOrgId.set(domain, organization.id);
        }
        return organization?.id || null;
      } catch (orgError) {
        console.warn('Organization resolution error (skipped org mapping):', orgError);
        return null;
      }
    };

    // Step 5: Process contacts with per-row error isolation
    for (const item of validItems) {
      try {
        const { cleanEmail, cleanDomain, companyName, raw } = item;
        const existingContactId = existingEmailToContactId.get(cleanEmail);

        if (existingContactId) {
          if (targetListId) {
            if (existingMemberContactIds.has(existingContactId)) {
              stats.duplicates++;
            } else {
              await prisma.listMember.create({
                data: { listId: targetListId, contactId: existingContactId }
              }).catch(err => {
                // If concurrent import created the membership, ignore unique collision
                console.warn('ListMember create notice:', err?.message);
              });
              existingMemberContactIds.add(existingContactId);
              stats.updated++;
            }
          } else {
            stats.duplicates++;
          }
        } else {
          // Resolve organization safely
          const orgId = await getOrCreateOrg(cleanDomain, companyName, raw);

          const firstName = typeof raw.firstName === 'string' ? raw.firstName.trim() : '';
          const lastName = typeof raw.lastName === 'string' ? raw.lastName.trim() : '';
          const fullName = `${firstName} ${lastName}`.trim() || null;

          const newContact = await prisma.contact.create({
            data: {
              workspaceId: workspace.id,
              userId: user.userId,
              organizationId: orgId,
              firstName: firstName || null,
              lastName: lastName || null,
              fullName,
              jobTitle: raw.jobTitle || null,
              linkedinUrl: raw.linkedinUrl || null,
              city: raw.city || null,
              personalizedLine: raw.personalizedLine || null,
              personalizationTrigger: raw.personalizationTrigger || null,
              emails: {
                create: [{
                  email: raw.email?.trim() || cleanEmail,
                  normalizedEmail: cleanEmail,
                  isPrimary: true
                }]
              }
            }
          });

          const newContactId = newContact.id;
          existingEmailToContactId.set(cleanEmail, newContactId);
          stats.new++;

          if (targetListId) {
            await prisma.listMember.create({
              data: { listId: targetListId, contactId: newContactId }
            }).catch(err => {
              console.warn('ListMember create notice:', err?.message);
            });
            existingMemberContactIds.add(newContactId);
          }
        }
      } catch (rowError) {
        console.error('Error importing single contact row:', rowError);
        stats.invalid++;
      }
    }
    
    res.status(200).json(stats);
  } catch (error: any) {
    console.error('Bulk import fatal error:', error);
    res.status(500).json({ error: error?.message || 'Failed to import contacts' });
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

export const revalidateSoftBounceContact = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { id } = req.params;
    const { confirm } = req.body;

    // 1. Require intentional user confirmation
    if (confirm !== true) {
      res.status(400).json({ 
        error: 'Intentional confirmation required. Set { confirm: true } to proceed with "Re-validate & Allow Sending".' 
      });
      return;
    }

    // 2. Authenticated & ownership protected
    const contact = await OwnershipGuard.assertContact(req, res, String(id));
    if (!contact) return;

    const contactWithEmails = await prisma.contact.findUnique({
      where: { id: contact.id },
      include: { emails: true }
    });

    if (!contactWithEmails || !contactWithEmails.emails || contactWithEmails.emails.length === 0) {
      res.status(404).json({ error: 'Contact has no email addresses on file.' });
      return;
    }

    const primaryEmail = contactWithEmails.emails.find(e => e.isPrimary) || contactWithEmails.emails[0];
    if (!primaryEmail) {
      res.status(404).json({ error: 'Contact has no email addresses on file.' });
      return;
    }
    const normEmail = primaryEmail.normalizedEmail?.toLowerCase() || primaryEmail.email?.toLowerCase();

    // 5. NEVER remove a hard-bounce or unsubscribe suppression
    const hardSuppression = await prisma.suppressionList.findFirst({
      where: { normalizedEmail: normEmail }
    });

    if (hardSuppression) {
      res.status(403).json({ 
        error: `Address is permanently suppressed (${hardSuppression.reason}). Hard-bounce or unsubscribe suppressions can NEVER be removed.` 
      });
      return;
    }

    if (primaryEmail.verificationStatus === 'bounced' || (primaryEmail.bounceCount && primaryEmail.bounceCount > 0)) {
      res.status(403).json({ 
        error: 'Contact email has a recorded hard bounce and cannot be unblocked.' 
      });
      return;
    }

    // 4. Perform syntax and domain validation before clearing block
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!normEmail || !emailRegex.test(normEmail)) {
      res.status(400).json({ error: 'Re-validation failed: Invalid email syntax or format.' });
      return;
    }

    const domain = normEmail.split('@')[1];
    if (!domain || !domain.includes('.')) {
      res.status(400).json({ error: 'Re-validation failed: Invalid domain format.' });
      return;
    }

    // Clear soft-bounce block on contactEmail (historical campaign enrollments remain soft_bounced as truthful audit record)
    await prisma.contactEmail.update({
      where: { id: primaryEmail.id },
      data: {
        verificationStatus: 'valid',
        isValid: true
      }
    });

    // 3. Log / Audit action in ActivityLog
    await prisma.activityLog.create({
      data: {
        workspaceId: contact.workspaceId,
        userId: user.userId,
        action: 'contact_soft_bounce_revalidated',
        description: `Explicit user action "Re-validate & Allow Sending" completed for ${primaryEmail.email}`,
        entityType: 'Contact',
        entityId: contact.id,
        metadata: {
          email: primaryEmail.email,
          previousStatus: primaryEmail.verificationStatus,
          revalidatedAt: new Date().toISOString(),
          performedBy: user.email || user.userId
        }
      }
    });

    res.status(200).json({
      success: true,
      message: 'Contact email successfully re-validated. Soft-bounce block cleared for future sends.',
      contactId: contact.id,
      email: primaryEmail.email,
      verificationStatus: 'valid'
    });
  } catch (error) {
    console.error('Error in revalidateSoftBounceContact:', error);
    res.status(500).json({ error: 'Failed to re-validate soft-bounced contact' });
  }
};
