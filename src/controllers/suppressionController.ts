import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { OwnershipGuard } from '../utils/ownershipGuard';

const prisma = new PrismaClient();

// Helper: Normalize email for suppression comparisons
export const normalizeEmailAddress = (email: string): string => {
  return (email || '').toLowerCase().trim();
};

/**
 * GET /api/suppression
 * Fetches all suppressed emails for the authenticated user
 */
export const getSuppressionList = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';

    const where: any = {
      OR: [
        { userId: user.userId },
        { userId: null } // System / global suppressions
      ]
    };

    if (search) {
      where.AND = [
        {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { normalizedEmail: { contains: search, mode: 'insensitive' } },
            { reason: { contains: search, mode: 'insensitive' } }
          ]
        }
      ];
    }

    const [total, items] = await Promise.all([
      prisma.suppressionList.count({ where }),
      prisma.suppressionList.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { suppressedAt: 'desc' }
      })
    ]);

    res.status(200).json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      suppressions: items.map((s: any) => ({
        id: s.id,
        email: s.email,
        normalizedEmail: s.normalizedEmail,
        reason: s.reason || 'do_not_contact',
        source: s.source || 'manual',
        notes: s.notes,
        suppressedAt: s.suppressedAt
      }))
    });
  } catch (error: any) {
    console.error('Error fetching suppression list:', error);
    res.status(500).json({ error: error?.message || 'Failed to fetch suppression list' });
  }
};

/**
 * POST /api/suppression
 * Adds one or more emails to the suppression list.
 * Guarantees zero campaign dispatch to the email across General and Bulk campaigns.
 */
export const addSuppression = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { email, emails, reason = 'do_not_contact', notes } = req.body || {};

    // Collect candidate emails from single string, array, or newline/comma string
    const rawEmails: string[] = [];
    if (typeof email === 'string' && email.trim()) {
      rawEmails.push(...email.split(/[\n,;]+/).map((e: string) => e.trim()));
    }
    if (Array.isArray(emails)) {
      for (const e of emails) {
        if (typeof e === 'string' && e.trim()) {
          rawEmails.push(...e.split(/[\n,;]+/).map((x: string) => x.trim()));
        }
      }
    }

    const validEmails = Array.from(new Set(
      rawEmails
        .map(e => normalizeEmailAddress(e))
        .filter(e => e.length > 3 && e.includes('@') && !e.startsWith('@') && !e.endsWith('@'))
    ));

    if (validEmails.length === 0) {
      res.status(400).json({ error: 'Please provide at least one valid email address to suppress.' });
      return;
    }

    const suppressedRecords: any[] = [];

    for (const normEmail of validEmails) {
      const originalEmail = rawEmails.find(r => normalizeEmailAddress(r) === normEmail) || normEmail;

      // 1. Upsert into SuppressionList table (Authoritative check for all dispatch engines)
      const record = await prisma.suppressionList.upsert({
        where: { normalizedEmail: normEmail },
        update: {
          reason: reason || 'do_not_contact',
          notes: notes || undefined,
          suppressedAt: new Date()
        },
        create: {
          email: originalEmail,
          normalizedEmail: normEmail,
          reason: reason || 'do_not_contact',
          source: 'manual_suppression',
          notes: notes || undefined,
          userId: user.userId
        }
      });
      suppressedRecords.push(record);

      // 2. Mark any matching Contacts as doNotContact and unsubscribed
      try {
        const matchingContacts = await prisma.contact.findMany({
          where: {
            OR: [
              { userId: user.userId },
              { workspace: { userId: user.userId } }
            ],
            emails: {
              some: { normalizedEmail: normEmail }
            }
          },
          select: { id: true }
        });

        if (matchingContacts.length > 0) {
          const contactIds = matchingContacts.map((c: any) => c.id);

          await prisma.contact.updateMany({
            where: { id: { in: contactIds } },
            data: {
              doNotContact: true,
              unsubscribeAt: new Date()
            }
          });

          // 3. Immediately halt any active or pending campaign enrollments for these contacts
          await prisma.enrollment.updateMany({
            where: {
              contactId: { in: contactIds },
              status: { in: ['pending', 'active'] }
            },
            data: {
              status: 'completed',
              stopReason: 'suppressed',
              stoppedAt: new Date()
            }
          });
        }
      } catch (err: any) {
        console.warn(`[Suppression] Warning updating contacts for ${normEmail}:`, err?.message);
      }
    }

    res.status(200).json({
      success: true,
      message: `Successfully added ${suppressedRecords.length} email(s) to suppression list. Campaigns will not send to these addresses.`,
      count: suppressedRecords.length,
      suppressed: suppressedRecords.map((s: any) => ({
        id: s.id,
        email: s.email,
        reason: s.reason,
        suppressedAt: s.suppressedAt
      }))
    });
  } catch (error: any) {
    console.error('Error adding to suppression list:', error);
    res.status(500).json({ error: error?.message || 'Failed to add email to suppression list' });
  }
};

/**
 * DELETE /api/suppression/:id
 * Removes an email from the suppression list
 */
export const removeSuppression = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const id = String(req.params.id || '');

    // Check if suppression exists and belongs to user (or matches email)
    const existing = await prisma.suppressionList.findFirst({
      where: {
        OR: [
          { id },
          { normalizedEmail: normalizeEmailAddress(id) }
        ],
        userId: user.userId
      }
    });

    if (!existing) {
      res.status(404).json({ error: 'Suppression record not found or cannot be modified.' });
      return;
    }

    await prisma.suppressionList.delete({
      where: { id: existing.id }
    });

    res.status(200).json({
      success: true,
      message: `Removed ${existing.email} from suppression list.`
    });
  } catch (error: any) {
    console.error('Error removing suppression:', error);
    res.status(500).json({ error: error?.message || 'Failed to remove suppression' });
  }
};
