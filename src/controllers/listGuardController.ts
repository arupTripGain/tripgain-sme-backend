import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { OwnershipGuard } from '../utils/ownershipGuard';
import { ListGuardQueue } from '../services/listGuard/listGuardQueue';
import { ListGuardStore } from '../services/listGuard/listGuardStore';
import { WorkerHealthService } from '../services/listGuard/workerHealth';
import { DiagnosticService } from '../services/listGuard/diagnosticService';

const prisma = new PrismaClient();

/**
 * GET /api/listguard/dashboard
 * Returns user's lists alongside their latest ListGuard verification status.
 */
export const getDashboard = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { search } = req.query;

    const whereClause: any = {
      userId: user.userId
    };

    if (search && typeof search === 'string') {
      whereClause.name = { contains: search, mode: 'insensitive' };
    }

    const lists = await prisma.list.findMany({
      where: whereClause,
      include: {
        _count: {
          select: { members: true }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    const formatted = await Promise.all(
      lists.map(async (list) => {
        const latestJob = await ListGuardStore.getLatestJobForList(prisma, list.id, user.userId);
        return {
          id: list.id,
          name: list.name,
          description: list.description,
          contactCount: list._count.members,
          listType: list.listType,
          createdAt: list.createdAt,
          updatedAt: list.updatedAt,
          latestVerification: latestJob
            ? {
                jobId: latestJob.id,
                status: latestJob.status,
                total: latestJob.total,
                processed: latestJob.processed,
                deliverable: latestJob.deliverable,
                undeliverable: latestJob.undeliverable,
                catchAll: latestJob.catchAll,
                unknown: latestJob.unknown,
                reusedFromCache: latestJob.reusedFromCache,
                verifiedAt: latestJob.completedAt || latestJob.startedAt || latestJob.createdAt
              }
            : null
        };
      })
    );

    res.status(200).json({ lists: formatted });
  } catch (error: any) {
    console.error('[ListGuard getDashboard Error]:', error);
    res.status(500).json({ error: 'Failed to retrieve ListGuard dashboard' });
  }
};

/**
 * POST /api/listguard/jobs
 * Initiates an asynchronous verification job for a list.
 */
export const startVerificationJob = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { listId, forceReverify } = req.body;
    if (!listId) {
      res.status(400).json({ error: 'listId is required' });
      return;
    }

    const list = await OwnershipGuard.assertList(req, res, String(listId));
    if (!list) return;

    const job = await ListGuardQueue.startJob({
      listId: list.id,
      userId: user.userId,
      forceReverify: Boolean(forceReverify)
    });

    res.status(201).json(job);
  } catch (error: any) {
    console.error('[ListGuard startVerificationJob Error]:', error);
    res.status(500).json({ error: error.message || 'Failed to start verification job' });
  }
};

/**
 * GET /api/listguard/jobs/:jobId
 * Returns the status, progress, and breakdown for a verification job.
 */
export const getJobStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { jobId } = req.params;
    const progress = await ListGuardQueue.getJobProgress(String(jobId), user.userId);

    if (!progress) {
      res.status(404).json({ error: 'Verification job not found or unauthorized' });
      return;
    }

    res.status(200).json(progress);
  } catch (error: any) {
    console.error('[ListGuard getJobStatus Error]:', error);
    res.status(500).json({ error: 'Failed to retrieve job status' });
  }
};

/**
 * POST /api/listguard/jobs/:jobId/cancel
 * Cancels a running or queued verification job.
 */
export const cancelJob = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { jobId } = req.params;
    const success = await ListGuardQueue.cancelJob(String(jobId), user.userId);

    if (!success) {
      res.status(404).json({ error: 'Verification job not found or cannot be cancelled' });
      return;
    }

    res.status(200).json({ success: true, message: 'Verification job cancelled' });
  } catch (error: any) {
    console.error('[ListGuard cancelJob Error]:', error);
    res.status(500).json({ error: 'Failed to cancel verification job' });
  }
};

/**
 * GET /api/listguard/jobs/:jobId/results
 * Returns paginated, searchable, filterable verification results for a job.
 */
export const getJobResults = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { jobId } = req.params;
    const {
      filter = 'ALL',
      search = '',
      sortBy = 'verifiedAt',
      sortOrder = 'desc',
      page = '1',
      pageSize = '50'
    } = req.query;

    const job = await ListGuardStore.findJobById(prisma, String(jobId), user.userId);
    if (!job) {
      res.status(404).json({ error: 'Verification job not found or unauthorized' });
      return;
    }

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limit = Math.max(1, Math.min(200, parseInt(String(pageSize), 10) || 50));

    const { results, totalCount } = await ListGuardStore.getResultsForJob(prisma, job.id, {
      filter: String(filter),
      search: String(search),
      sortBy: String(sortBy),
      sortOrder: String(sortOrder).toLowerCase() === 'asc' ? 'asc' : 'desc',
      page: pageNum,
      pageSize: limit
    });

    // Populate contact details if contactId is present
    const contactIds = results.map(r => r.contactId).filter(Boolean) as string[];
    const contacts = contactIds.length > 0
      ? await prisma.contact.findMany({
          where: { id: { in: contactIds } },
          include: {
            organization: {
              select: { name: true, industry: true, websiteUrl: true }
            }
          }
        })
      : [];

    const contactMap = new Map(contacts.map(c => [c.id, c]));

    const formatted = results.map(r => {
      const c = r.contactId ? contactMap.get(r.contactId) : null;
      return {
        id: r.id,
        email: r.email,
        normalizedEmail: r.normalizedEmail,
        result: r.result,
        verificationReason: r.verificationReason || 'UNKNOWN',
        confidence: r.confidence || (r.result === 'DELIVERABLE' || r.result === 'UNDELIVERABLE' ? 'HIGH' : 'MEDIUM'),
        verifierVersion: '1.0.0',
        syntaxStatus: r.syntaxStatus,
        domainStatus: r.domainStatus,
        mxStatus: r.mxStatus,
        smtpStatus: r.smtpStatus,
        isCatchAll: r.isCatchAll,
        isDisposable: r.isDisposable,
        isRole: r.isRole,
        suppressionStatus: r.suppressionStatus || null,
        bounceStatus: r.bounceStatus || null,
        smtpResponseCode: r.smtpResponseCode || null,
        smtpResponse: r.smtpResponse || null,
        verifiedAt: r.verifiedAt,
        expiresAt: r.expiresAt,
        contact: c
          ? {
              id: c.id,
              firstName: c.firstName,
              lastName: c.lastName,
              fullName: c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
              jobTitle: c.jobTitle,
              companyName: c.organization?.name || null,
              industry: c.organization?.industry || null,
              city: c.city,
              phone: c.phone
            }
          : null
      };
    });

    res.status(200).json({
      jobId: job.id,
      totalCount,
      page: pageNum,
      pageSize: limit,
      totalPages: Math.ceil(totalCount / limit) || 1,
      results: formatted
    });
  } catch (error: any) {
    console.error('[ListGuard getJobResults Error]:', error);
    res.status(500).json({ error: 'Failed to retrieve verification results' });
  }
};

/**
 * GET /api/listguard/jobs/:jobId/export
 * Exports the complete result set matching the selected result filters to CSV.
 * NEVER truncates or limits to UI pagination.
 */
export const exportResults = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { jobId } = req.params;
    const { results: rawResults, includeDetails = 'true' } = req.query;

    const job = await ListGuardStore.findJobById(prisma, String(jobId), user.userId);
    if (!job) {
      res.status(404).json({ error: 'Verification job not found or unauthorized' });
      return;
    }

    const list = await prisma.list.findUnique({
      where: { id: job.listId },
      select: { name: true }
    });

    let selectedStatuses: string[] | undefined = undefined;
    if (rawResults && typeof rawResults === 'string') {
      selectedStatuses = rawResults
        .split(',')
        .map(s => s.trim().toUpperCase())
        .filter(s => ['DELIVERABLE', 'UNDELIVERABLE', 'CATCH_ALL', 'UNKNOWN'].includes(s));
    }

    // Fetch COMPLETE result set (no UI pagination)
    const records = await ListGuardStore.getAllResultsForJob(prisma, job.id, selectedStatuses);

    // Fetch contact information for records
    const contactIds = records.map(r => r.contactId).filter(Boolean) as string[];
    const contacts = contactIds.length > 0
      ? await prisma.contact.findMany({
          where: { id: { in: contactIds } },
          include: { organization: true }
        })
      : [];
    const contactMap = new Map(contacts.map(c => [c.id, c]));

    const shouldIncludeDetails = String(includeDetails).toLowerCase() === 'true';

    // Build CSV Headers
    const headers = [
      'Company',
      'First Name',
      'Last Name',
      'Title',
      'Email',
      'Phone',
      'Website',
      'City',
      'Industry',
      'Email Status',
      'Verification Reason'
    ];

    if (shouldIncludeDetails) {
      headers.push(
        'Syntax Status',
        'Domain Status',
        'MX Status',
        'SMTP Status',
        'SMTP Response Code',
        'SMTP Response',
        'Catch-all',
        'Disposable',
        'Role Account',
        'Verification Date'
      );
    }

    // Format rows safely with CSV quoting
    const escapeCsv = (val: any): string => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const rows: string[] = [];
    rows.push(headers.join(','));

    for (const r of records) {
      const c = r.contactId ? contactMap.get(r.contactId) : null;
      const org = c?.organization;

      const row = [
        escapeCsv(org?.name || ''),
        escapeCsv(c?.firstName || ''),
        escapeCsv(c?.lastName || ''),
        escapeCsv(c?.jobTitle || ''),
        escapeCsv(r.email),
        escapeCsv(c?.phone || ''),
        escapeCsv(org?.websiteUrl || ''),
        escapeCsv(c?.city || ''),
        escapeCsv(org?.industry || ''),
        escapeCsv(r.result),
        escapeCsv(r.verificationReason || 'UNKNOWN')
      ];

      if (shouldIncludeDetails) {
        row.push(
          escapeCsv(r.syntaxStatus),
          escapeCsv(r.domainStatus),
          escapeCsv(r.mxStatus),
          escapeCsv(r.smtpStatus),
          escapeCsv(r.smtpResponseCode !== null && r.smtpResponseCode !== undefined ? r.smtpResponseCode : ''),
          escapeCsv(r.smtpResponse || ''),
          escapeCsv(r.isCatchAll ? 'Yes' : 'No'),
          escapeCsv(r.isDisposable ? 'Yes' : 'No'),
          escapeCsv(r.isRole ? 'Yes' : 'No'),
          escapeCsv(r.verifiedAt instanceof Date ? r.verifiedAt.toISOString() : String(r.verifiedAt))
        );
      }

      rows.push(row.join(','));
    }

    const csvContent = rows.join('\r\n');
    const safeListName = (list?.name || 'List').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `ListGuard_${safeListName}_${Date.now()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csvContent);
  } catch (error: any) {
    console.error('[ListGuard exportResults Error]:', error);
    res.status(500).json({ error: 'Failed to export verification results' });
  }
};

/**
 * POST /api/listguard/jobs/:jobId/create-list
 * Generates a derived Clean List from selected verification categories.
 * The original list remains completely untouched.
 */
export const createCleanList = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { jobId } = req.params;
    const { name, statuses } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'A valid list name is required' });
      return;
    }

    if (!statuses || !Array.isArray(statuses) || statuses.length === 0) {
      res.status(400).json({ error: 'At least one status category must be selected' });
      return;
    }

    const cleanStatuses = statuses
      .map(s => String(s).toUpperCase())
      .filter(s => ['DELIVERABLE', 'UNDELIVERABLE', 'CATCH_ALL', 'UNKNOWN'].includes(s));

    if (cleanStatuses.length === 0) {
      res.status(400).json({ error: 'Valid status categories are required' });
      return;
    }

    const job = await ListGuardStore.findJobById(prisma, String(jobId), user.userId);
    if (!job) {
      res.status(404).json({ error: 'Verification job not found or unauthorized' });
      return;
    }

    const list = await prisma.list.findUnique({
      where: { id: job.listId }
    });

    // Query matching records from this job
    const allResults = await ListGuardStore.getAllResultsForJob(prisma, job.id, cleanStatuses);
    const uniqueContactIds = Array.from(
      new Set(allResults.map(r => r.contactId).filter(Boolean) as string[])
    );

    // Get user's workspace
    const workspace = await prisma.workspace.findFirst({
      where: { userId: user.userId }
    }) || await prisma.workspace.findFirst();

    if (!workspace) {
      res.status(500).json({ error: 'Workspace configuration missing' });
      return;
    }

    // 1. Create the new clean List (derived list)
    const cleanList = await prisma.list.create({
      data: {
        name: name.trim(),
        description: `Clean list generated by ListGuard from "${list?.name || 'List'}" (${cleanStatuses.join(', ')})`,
        listType: 'static',
        workspaceId: workspace.id,
        userId: user.userId
      }
    });

    // 2. Create unique ListMember records for each verified contact
    if (uniqueContactIds.length > 0) {
      const listMemberData = uniqueContactIds.map(cid => ({
        listId: cleanList.id,
        contactId: cid,
        addedBy: user.userId,
        membershipStatus: 'active'
      }));

      await prisma.listMember.createMany({
        data: listMemberData,
        skipDuplicates: true
      });
    }

    res.status(201).json({
      success: true,
      listId: cleanList.id,
      name: cleanList.name,
      contactCount: uniqueContactIds.length,
      message: `Clean list "${cleanList.name}" created with ${uniqueContactIds.length} contacts.`
    });
  } catch (error: any) {
    console.error('[ListGuard createCleanList Error]:', error);
    res.status(500).json({ error: 'Failed to create clean list' });
  }
};

/**
 * POST /api/listguard/jobs/:jobId/update-list
 * Updates the existing list by retaining only contacts matching the selected verification categories.
 * Contacts matching unselected categories are removed from list memberships.
 */
export const updateList = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { jobId } = req.params;
    const { statuses } = req.body;

    if (!statuses || !Array.isArray(statuses) || statuses.length === 0) {
      res.status(400).json({ error: 'At least one status category must be selected' });
      return;
    }

    const cleanStatuses = statuses
      .map(s => String(s).toUpperCase())
      .filter(s => ['DELIVERABLE', 'UNDELIVERABLE', 'CATCH_ALL', 'UNKNOWN'].includes(s));

    if (cleanStatuses.length === 0) {
      res.status(400).json({ error: 'Valid status categories are required' });
      return;
    }

    const job = await ListGuardStore.findJobById(prisma, String(jobId), user.userId);
    if (!job) {
      res.status(404).json({ error: 'Verification job not found or unauthorized' });
      return;
    }

    const list = await OwnershipGuard.assertList(req, res, job.listId);
    if (!list) return;

    // Get all results for this job
    const allResults = await ListGuardStore.getAllResultsForJob(prisma, job.id);

    const keptResults = allResults.filter(r => cleanStatuses.includes(r.result));
    const removedResults = allResults.filter(r => !cleanStatuses.includes(r.result));

    const keepContactIds = Array.from(
      new Set(keptResults.map(r => r.contactId).filter(Boolean) as string[])
    );
    const removeContactIds = Array.from(
      new Set(removedResults.map(r => r.contactId).filter(Boolean) as string[])
    ).filter(id => !keepContactIds.includes(id));

    // Remove unselected contacts from this list's memberships
    if (removeContactIds.length > 0) {
      await prisma.listMember.deleteMany({
        where: {
          listId: list.id,
          contactId: { in: removeContactIds }
        }
      });
    }

    // Ensure all keepContactIds are active members in this list
    if (keepContactIds.length > 0) {
      await prisma.listMember.createMany({
        data: keepContactIds.map(cid => ({
          listId: list.id,
          contactId: cid,
          addedBy: user.userId,
          membershipStatus: 'active'
        })),
        skipDuplicates: true
      });
    }

    const totalRemaining = await prisma.listMember.count({
      where: { listId: list.id }
    });

    res.status(200).json({
      success: true,
      listId: list.id,
      listName: list.name,
      keptCount: keepContactIds.length,
      removedCount: removeContactIds.length,
      totalRemaining,
      message: `List "${list.name}" updated: ${keepContactIds.length} contacts kept, ${removeContactIds.length} removed.`
    });
  } catch (error: any) {
    console.error('[ListGuard updateList Error]:', error);
    res.status(500).json({ error: 'Failed to update list' });
  }
};


/**
 * GET /api/listguard/lists/:listId/history
 * Returns the history of verification jobs for a list.
 */
export const getListHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { listId } = req.params;
    const list = await OwnershipGuard.assertList(req, res, String(listId));
    if (!list) return;

    const jobs = await ListGuardStore.findJobsByListId(prisma, list.id, user.userId);

    res.status(200).json({
      listId: list.id,
      listName: list.name,
      history: jobs
    });
  } catch (error: any) {
    console.error('[ListGuard getListHistory Error]:', error);
    res.status(500).json({ error: 'Failed to retrieve list history' });
  }
};

/**
 * GET /api/listguard/worker-status
 * Returns current status and availability of the dedicated verification worker.
 */
export const getWorkerStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const health = await WorkerHealthService.getWorkerHealthStatus(prisma);
    res.status(200).json(health);
  } catch (error: any) {
    console.error('[ListGuard getWorkerStatus Error]:', error);
    res.status(500).json({ error: 'Failed to retrieve worker status' });
  }
};

/**
 * GET /api/listguard/diagnose?email=...
 * Performs protocol-level diagnostics for a single email without executing SMTP DATA.
 */
export const diagnoseEmail = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const email = String(req.query.email || req.body?.email || '').trim();
    if (!email) {
      res.status(400).json({ error: 'Email parameter is required' });
      return;
    }

    const report = await DiagnosticService.runDiagnostics(prisma, email, user.userId);
    res.status(200).json(report);
  } catch (error: any) {
    console.error('[ListGuard diagnoseEmail Error]:', error);
    res.status(500).json({ error: 'Failed to execute email diagnostics' });
  }
};

