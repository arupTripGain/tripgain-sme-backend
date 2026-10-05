import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { OwnershipGuard } from '../utils/ownershipGuard';
import { 
  parseLeadDeterministic, 
  parseLeadWithAiFallback, 
  normalizeUrl,
  ParsedLeadData,
  FieldStatusMap
} from '../services/smartLeadParser';

const prisma = new PrismaClient();

// Helper to get or create default workspace for user
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

export interface SmartLeadDuplicateCheckResult {
  isDuplicate: boolean;
  reason: 'EXACT_EMAIL' | 'EXACT_LINKEDIN' | 'CONTACT_AND_ORGANIZATION' | null;
  contactId: string | null;
  existingContact: {
    id: string;
    fullName: string | null;
    email: string | null;
    jobTitle: string | null;
    companyName: string | null;
    linkedinUrl: string | null;
  } | null;
  existingListIds: string[];
}

/**
 * Checks if a contact already exists for the given user using the priority order:
 * 1. Exact email
 * 2. Exact normalized LinkedIn URL
 * 3. Existing contact + organization
 */
export async function findDuplicateContact(
  userId: string,
  lead: {
    email?: string | null;
    linkedinUrl?: string | null;
    fullName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    companyName?: string | null;
    websiteUrl?: string | null;
  }
): Promise<SmartLeadDuplicateCheckResult> {
  const cleanEmail = lead.email ? lead.email.trim().toLowerCase() : null;
  const cleanLinkedin = lead.linkedinUrl ? normalizeUrl(lead.linkedinUrl) : null;
  const fullName = (lead.fullName || `${lead.firstName || ''} ${lead.lastName || ''}`).trim();
  const companyName = lead.companyName ? lead.companyName.trim() : null;

  // 1. Exact email check
  if (cleanEmail) {
    const emailRecord = await prisma.contactEmail.findFirst({
      where: {
        normalizedEmail: cleanEmail,
        contact: { userId }
      },
      include: {
        contact: {
          include: {
            organization: true,
            emails: true,
            listMemberships: true
          }
        }
      }
    });

    if (emailRecord && emailRecord.contact) {
      const c = emailRecord.contact;
      return {
        isDuplicate: true,
        reason: 'EXACT_EMAIL',
        contactId: c.id,
        existingContact: {
          id: c.id,
          fullName: c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim() || null,
          email: emailRecord.email,
          jobTitle: c.jobTitle,
          companyName: c.organization?.name || null,
          linkedinUrl: c.linkedinUrl
        },
        existingListIds: c.listMemberships.map(m => m.listId)
      };
    }
  }

  // 2. Exact normalized LinkedIn URL check
  if (cleanLinkedin) {
    const linkedinContact = await prisma.contact.findFirst({
      where: {
        userId,
        linkedinUrl: {
          equals: cleanLinkedin,
          mode: 'insensitive'
        }
      },
      include: {
        organization: true,
        emails: true,
        listMemberships: true
      }
    });

    if (linkedinContact) {
      const primaryEmail = linkedinContact.emails.find(e => e.isPrimary)?.email || linkedinContact.emails[0]?.email || null;
      return {
        isDuplicate: true,
        reason: 'EXACT_LINKEDIN',
        contactId: linkedinContact.id,
        existingContact: {
          id: linkedinContact.id,
          fullName: linkedinContact.fullName,
          email: primaryEmail,
          jobTitle: linkedinContact.jobTitle,
          companyName: linkedinContact.organization?.name || null,
          linkedinUrl: linkedinContact.linkedinUrl
        },
        existingListIds: linkedinContact.listMemberships.map(m => m.listId)
      };
    }
  }

  // 3. Existing contact + organization check
  if (fullName && companyName) {
    const contactWithOrg = await prisma.contact.findFirst({
      where: {
        userId,
        fullName: {
          equals: fullName,
          mode: 'insensitive'
        },
        organization: {
          name: {
            equals: companyName,
            mode: 'insensitive'
          }
        }
      },
      include: {
        organization: true,
        emails: true,
        listMemberships: true
      }
    });

    if (contactWithOrg) {
      const primaryEmail = contactWithOrg.emails.find(e => e.isPrimary)?.email || contactWithOrg.emails[0]?.email || null;
      return {
        isDuplicate: true,
        reason: 'CONTACT_AND_ORGANIZATION',
        contactId: contactWithOrg.id,
        existingContact: {
          id: contactWithOrg.id,
          fullName: contactWithOrg.fullName,
          email: primaryEmail,
          jobTitle: contactWithOrg.jobTitle,
          companyName: contactWithOrg.organization?.name || null,
          linkedinUrl: contactWithOrg.linkedinUrl
        },
        existingListIds: contactWithOrg.listMemberships.map(m => m.listId)
      };
    }
  }

  return {
    isDuplicate: false,
    reason: null,
    contactId: null,
    existingContact: null,
    existingListIds: []
  };
}

/**
 * POST /api/contacts/smart-parse
 * Parses pasted raw text deterministically (with optional AI fallback if ambiguous)
 * and checks for duplicates against the user's existing contacts.
 */
export const smartParseLead = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { text, useAiFallback } = req.body;

    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Please enter lead information to parse.' });
      return;
    }

    // Parse text
    const parseResult = useAiFallback
      ? await parseLeadWithAiFallback(text, user.userId)
      : parseLeadDeterministic(text);

    if (!parseResult.success) {
      res.status(400).json({ 
        error: parseResult.error || 'No recognizable lead information could be extracted.',
        fieldStatus: parseResult.fieldStatus
      });
      return;
    }

    // Check duplicate in database
    const duplicate = await findDuplicateContact(user.userId, parseResult.parsed);

    res.status(200).json({
      parsed: parseResult.parsed,
      fieldStatus: parseResult.fieldStatus,
      confidence: parseResult.confidence,
      warnings: parseResult.warnings,
      duplicate
    });
  } catch (error: any) {
    console.error('Error in smartParseLead:', error);
    res.status(500).json({ error: error.message || 'Failed to parse lead information' });
  }
};

/**
 * POST /api/contacts/smart-add
 * Saves or updates a lead, resolves/creates organization, handles list assignment & inline list creation.
 */
export const smartAddLead = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { lead, listIds, newListName } = req.body;

    if (!lead || typeof lead !== 'object') {
      res.status(400).json({ error: 'Lead details are required.' });
      return;
    }

    const rawEmail = typeof lead.email === 'string' ? lead.email.trim() : '';
    const cleanEmail = rawEmail.toLowerCase();
    
    // 1. Validate email if present
    if (cleanEmail) {
      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      if (!emailRegex.test(cleanEmail)) {
        res.status(400).json({ error: 'Invalid email address format provided.' });
        return;
      }
    }

    // 2. Validate URLs if present
    let normalizedLinkedin = lead.linkedinUrl ? normalizeUrl(lead.linkedinUrl) : null;
    let normalizedWebsite = lead.websiteUrl ? normalizeUrl(lead.websiteUrl) : null;

    // 3. Ensure at least some recognizable contact information exists
    const firstName = typeof lead.firstName === 'string' ? lead.firstName.trim() : '';
    const lastName = typeof lead.lastName === 'string' ? lead.lastName.trim() : '';
    const fullName = (lead.fullName || `${firstName} ${lastName}`).trim();
    const jobTitle = typeof lead.jobTitle === 'string' ? lead.jobTitle.trim() : null;
    const companyName = typeof lead.companyName === 'string' ? lead.companyName.trim() : null;

    if (!cleanEmail && !fullName && !normalizedLinkedin && !companyName) {
      res.status(400).json({ error: 'Lead does not contain recognizable name, email, or company information.' });
      return;
    }

    const workspace = await getWorkspace(user.userId);

    // 4. Resolve Organization
    let domain: string | null = null;
    if (normalizedWebsite) {
      try {
        domain = new URL(normalizedWebsite).hostname.replace(/^www\./, '').toLowerCase();
      } catch {}
    }
    if (!domain && cleanEmail) {
      const parts = cleanEmail.split('@');
      const publicDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'rediffmail.com'];
      if (parts.length === 2 && !publicDomains.includes(parts[1])) {
        domain = parts[1].toLowerCase();
      }
    }

    let organization = null;
    if (domain) {
      organization = await prisma.organization.findUnique({
        where: { workspaceId_domain: { workspaceId: workspace.id, domain } }
      });
    }

    if (!organization && companyName) {
      organization = await prisma.organization.findFirst({
        where: { 
          workspaceId: workspace.id, 
          name: { equals: companyName, mode: 'insensitive' } 
        }
      });
    }

    if (!organization && (companyName || domain)) {
      organization = await prisma.organization.create({
        data: {
          workspaceId: workspace.id,
          name: companyName || domain || 'Unknown Company',
          domain: domain || null,
          websiteUrl: normalizedWebsite || null
        }
      });
    } else if (organization && normalizedWebsite && !organization.websiteUrl) {
      // Safely update organization website if missing
      await prisma.organization.update({
        where: { id: organization.id },
        data: { websiteUrl: normalizedWebsite }
      });
    }

    // 5. Check if contact already exists
    const duplicateCheck = await findDuplicateContact(user.userId, {
      email: cleanEmail || null,
      linkedinUrl: normalizedLinkedin || null,
      fullName: fullName || null,
      companyName: companyName || null
    });

    let contactId: string;
    let isExisting = false;

    if (duplicateCheck.isDuplicate && duplicateCheck.contactId) {
      // Contact already exists! DO NOT create duplicate contact.
      contactId = duplicateCheck.contactId;
      isExisting = true;

      // Update missing fields only where safe
      const existing = await prisma.contact.findUnique({
        where: { id: contactId },
        include: { emails: true }
      });

      if (existing) {
        const updateData: any = {};
        if (!existing.firstName && firstName) updateData.firstName = firstName;
        if (!existing.lastName && lastName) updateData.lastName = lastName;
        if (!existing.fullName && fullName) updateData.fullName = fullName;
        if (!existing.jobTitle && jobTitle) updateData.jobTitle = jobTitle;
        if (!existing.linkedinUrl && normalizedLinkedin) updateData.linkedinUrl = normalizedLinkedin;
        if (!existing.organizationId && organization?.id) updateData.organizationId = organization.id;

        if (Object.keys(updateData).length > 0) {
          await prisma.contact.update({
            where: { id: contactId },
            data: updateData
          });
        }

        // If contact had no email and now we have one, add it
        if (cleanEmail && existing.emails.length === 0) {
          await prisma.contactEmail.create({
            data: {
              contactId: existing.id,
              email: rawEmail || cleanEmail,
              normalizedEmail: cleanEmail,
              isPrimary: true
            }
          });
        }
      }
    } else {
      // 6. Create contact using existing Contact model
      const contactCreateData: any = {
        workspaceId: workspace.id,
        userId: user.userId,
        organizationId: organization?.id || null,
        firstName: firstName || null,
        lastName: lastName || null,
        fullName: fullName || `${firstName} ${lastName}`.trim() || null,
        jobTitle: jobTitle || null,
        linkedinUrl: normalizedLinkedin || null,
        source: 'SMART_IMPORT'
      };

      if (cleanEmail) {
        contactCreateData.emails = {
          create: [{
            email: rawEmail || cleanEmail,
            normalizedEmail: cleanEmail,
            isPrimary: true
          }]
        };
      }

      const createdContact = await prisma.contact.create({
        data: contactCreateData
      });
      contactId = createdContact.id;
    }

    // 7. Resolve List(s) and inline list creation
    const targetListIds = new Set<string>();

    if (Array.isArray(listIds)) {
      for (const id of listIds) {
        if (id && typeof id === 'string') {
          targetListIds.add(id);
        }
      }
    }

    // Inline list creation
    if (newListName && typeof newListName === 'string' && newListName.trim()) {
      const trimmedListName = newListName.trim();
      
      // Normalize list name for duplicate checking
      const existingList = await prisma.list.findFirst({
        where: {
          userId: user.userId,
          name: {
            equals: trimmedListName,
            mode: 'insensitive'
          }
        }
      });

      if (existingList) {
        targetListIds.add(existingList.id);
      } else {
        const newList = await prisma.list.create({
          data: {
            workspaceId: workspace.id,
            userId: user.userId,
            name: trimmedListName,
            listType: 'static'
          }
        });
        targetListIds.add(newList.id);
      }
    }

    // 8. Create list memberships for all resolved lists
    const addedToListNames: string[] = [];
    for (const listId of Array.from(targetListIds)) {
      // Verify list belongs to user
      const list = await prisma.list.findFirst({
        where: { id: listId, userId: user.userId }
      });
      if (list) {
        await prisma.listMember.upsert({
          where: { listId_contactId: { listId: list.id, contactId } },
          create: {
            listId: list.id,
            contactId,
            membershipStatus: 'active'
          },
          update: {}
        });
        addedToListNames.push(list.name);
      }
    }

    // Fetch refreshed contact to return complete representation
    const finalContact = await prisma.contact.findUnique({
      where: { id: contactId },
      include: {
        organization: true,
        emails: true,
        listMemberships: {
          include: { list: true }
        }
      }
    });

    res.status(isExisting ? 200 : 201).json({
      success: true,
      isExisting,
      message: isExisting 
        ? `${finalContact?.fullName || 'Contact'} already existed and was updated / added to list(s).` 
        : `${finalContact?.fullName || 'Contact'} added successfully.`,
      contact: {
        id: finalContact?.id,
        firstName: finalContact?.firstName,
        lastName: finalContact?.lastName,
        fullName: finalContact?.fullName,
        jobTitle: finalContact?.jobTitle,
        email: finalContact?.emails.find(e => e.isPrimary)?.email || finalContact?.emails[0]?.email || null,
        companyName: finalContact?.organization?.name || null,
        website: finalContact?.organization?.websiteUrl || finalContact?.organization?.domain || null,
        linkedinUrl: finalContact?.linkedinUrl,
        source: finalContact?.source
      },
      lists: addedToListNames
    });
  } catch (error: any) {
    console.error('Error in smartAddLead:', error);
    res.status(500).json({ error: error.message || 'Failed to save lead' });
  }
};
