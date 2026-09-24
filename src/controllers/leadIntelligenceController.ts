import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import { OwnershipGuard } from '../utils/ownershipGuard';
import { processLeadIntelligencePipeline } from '../services/leadIntelligence/leadIntelligencePipeline';
import { generateLeadsCsv, generateBatchLeadsCsv, generateCompanyExhibitorCsv } from '../services/leadIntelligence/exportService';
import { validatePublicUrl } from '../services/leadIntelligence/urlFetcherService';
import { BatchQueueService } from '../services/leadIntelligence/batchQueueService';
import { normalizeDomain } from '../services/leadIntelligence/normalizationService';

const prisma = new PrismaClient();

// Multer memory storage configured with 25MB limit to prevent PayloadTooLargeError
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/pdf',
      'text/plain',
    ];
    // Also allow extension check if mime is octet-stream
    const name = file.originalname.toLowerCase();
    const hasValidExt = name.endsWith('.csv') || name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.pdf') || name.endsWith('.txt');

    if (allowed.includes(file.mimetype) || hasValidExt) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file format. Supported formats: CSV, XLSX, XLS, PDF, TXT.'));
    }
  },
});

export const uploadFileMiddleware = upload.single('file');

/**
 * Helper to ensure user has an associated workspaceId
 */
async function resolveUserWorkspaceId(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { workspaceId: true },
  });
  if (user?.workspaceId) return user.workspaceId;

  const workspace = await prisma.workspace.findFirst({
    where: { userId },
    select: { id: true },
  });
  return workspace ? workspace.id : null;
}

/**
 * POST /api/lead-intelligence/sources/upload
 * Dedicated multipart form-data endpoint
 */
export async function uploadSourceFile(req: Request, res: Response): Promise<void> {
  try {
    const user = OwnershipGuard.requireAdmin(req, res);
    if (!user) return;

    if (!req.file) {
      res.status(400).json({ error: 'No file was uploaded.' });
      return;
    }

    const { originalname, buffer, mimetype, size } = req.file;
    const lowerName = originalname.toLowerCase();

    let sourceType: 'CSV' | 'XLSX' | 'PDF' = 'CSV';
    if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {
      sourceType = 'XLSX';
    } else if (lowerName.endsWith('.pdf') || mimetype === 'application/pdf') {
      sourceType = 'PDF';
    }

    const sourceName = req.body.sourceName?.trim() || originalname;
    const workspaceId = await resolveUserWorkspaceId(user.userId);

    // 1. Create Source entity
    const source = await prisma.leadIntelligenceSource.create({
      data: {
        userId: user.userId,
        workspaceId,
        sourceType,
        name: sourceName,
        originalFileName: originalname,
        fileSizeBytes: size,
        mimeType: mimetype,
        status: 'QUEUED',
      },
    });

    // 2. Process pipeline
    const result = await processLeadIntelligencePipeline({
      sourceId: source.id,
      userId: user.userId,
      workspaceId,
      fileBuffer: buffer,
      sourceName,
      sourceType,
    });

    res.status(201).json({
      success: true,
      sourceId: source.id,
      status: result.status,
      stats: {
        total: result.totalRecords,
        valid: result.validCount,
        duplicates: result.duplicateCount,
        errors: result.errorCount,
      },
      errorMessage: result.errorMessage,
    });
  } catch (error: any) {
    console.error('Lead Intelligence file upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to process uploaded file.' });
  }
}

/**
 * POST /api/lead-intelligence/sources/pasted-text
 */
export async function processPastedText(req: Request, res: Response): Promise<void> {
  try {
    const user = OwnershipGuard.requireAdmin(req, res);
    if (!user) return;

    const { text, sourceName } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Text content is required.' });
      return;
    }

    const name = sourceName?.trim() || `Pasted Batch (${new Date().toLocaleDateString()})`;
    const workspaceId = await resolveUserWorkspaceId(user.userId);

    const source = await prisma.leadIntelligenceSource.create({
      data: {
        userId: user.userId,
        workspaceId,
        sourceType: 'PASTED_TEXT',
        name,
        fileSizeBytes: Buffer.byteLength(text, 'utf-8'),
        status: 'QUEUED',
        metadata: { preview: text.slice(0, 200) },
      },
    });

    const result = await processLeadIntelligencePipeline({
      sourceId: source.id,
      userId: user.userId,
      workspaceId,
      pastedText: text,
      sourceName: name,
      sourceType: 'PASTED_TEXT',
    });

    res.status(201).json({
      success: true,
      sourceId: source.id,
      status: result.status,
      stats: {
        total: result.totalRecords,
        valid: result.validCount,
        duplicates: result.duplicateCount,
        errors: result.errorCount,
      },
      errorMessage: result.errorMessage,
    });
  } catch (error: any) {
    console.error('Lead Intelligence pasted text error:', error);
    res.status(500).json({ error: error.message || 'Failed to process pasted text.' });
  }
}

/**
 * POST /api/lead-intelligence/sources/url
 * Asynchronous, persistent batch creation endpoint (<300ms)
 */
export async function processUrl(req: Request, res: Response): Promise<void> {
  try {
    const user = OwnershipGuard.requireAdmin(req, res);
    if (!user) return;

    const { url, sourceName, batchName, maxRecords, maxDetailPages, maxRequests, maxPages, mode } = req.body;
    if (!url || typeof url !== 'string' || !url.trim()) {
      res.status(400).json({ error: 'URL is required.' });
      return;
    }

    const trimmedUrl = url.trim();

    // 1. SSRF Validation
    await validatePublicUrl(trimmedUrl);

    let parsedHostname = '';
    try {
      parsedHostname = new URL(trimmedUrl.startsWith('http') ? trimmedUrl : 'https://' + trimmedUrl).hostname;
    } catch {}

    const name = sourceName?.trim() || `Website Research (${parsedHostname || 'Directory'})`;
    const finalBatchName = batchName?.trim() || name;
    const workspaceId = await resolveUserWorkspaceId(user.userId);

    // 2. Create Source in database
    const source = await prisma.leadIntelligenceSource.create({
      data: {
        userId: user.userId,
        workspaceId,
        sourceType: 'WEBSITE',
        name,
        url: trimmedUrl,
        status: 'QUEUED',
      },
    });

    // 3. Create Research Batch in database
    const batch = await prisma.leadIntelligenceResearchBatch.create({
      data: {
        userId: user.userId,
        workspaceId,
        sourceId: source.id,
        sourceUrl: trimmedUrl,
        name: finalBatchName,
        status: 'QUEUED',
      },
    });

    // 4. Enqueue in persistent background queue (returns immediately)
    await BatchQueueService.enqueueBatch({
      batchId: batch.id,
      sourceId: source.id,
      userId: user.userId,
      workspaceId,
      url: trimmedUrl,
      sourceName: name,
      maxRecords: maxRecords ? parseInt(maxRecords, 10) : undefined,
      maxDetailPages: maxDetailPages ? parseInt(maxDetailPages, 10) : undefined,
      maxRequests: maxRequests ? parseInt(maxRequests, 10) : undefined,
      maxPages: maxPages ? parseInt(maxPages, 10) : undefined,
      mode: mode === 'sample' || mode === 'limited' || mode === 'all' ? mode : undefined,
    });

    res.status(201).json({
      success: true,
      batchId: batch.id,
      sourceId: source.id,
      status: 'QUEUED',
      message: 'Research batch queued successfully for background execution.',
    });
  } catch (error: any) {
    console.error('Lead Intelligence URL error:', error);
    const statusCode = error.name === 'UrlSecurityError' ? 400 : 500;
    res.status(statusCode).json({ error: error.message || 'Failed to process website URL.' });
  }
}

/**
 * GET /api/lead-intelligence/sources
 */
export async function getSources(req: Request, res: Response): Promise<void> {
  try {
    const user = OwnershipGuard.requireAdmin(req, res);
    if (!user) return;

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const skip = (page - 1) * limit;

    const where: any = { userId: user.userId };
    if (req.query.sourceType) {
      where.sourceType = req.query.sourceType;
    }

    const [total, sources] = await Promise.all([
      prisma.leadIntelligenceSource.count({ where }),
      prisma.leadIntelligenceSource.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    res.json({
      sources,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('Lead Intelligence getSources error:', error);
    res.status(500).json({ error: 'Failed to retrieve sources.' });
  }
}

/**
 * GET /api/lead-intelligence/sources/:id
 */
export async function getSourceDetail(req: Request, res: Response): Promise<void> {
  try {
    const user = OwnershipGuard.requireAdmin(req, res);
    if (!user) return;

    const id = String(req.params.id);
    const source = await prisma.leadIntelligenceSource.findFirst({
      where: { id, userId: user.userId },
      include: {
        rawRecords: {
          take: 50,
          orderBy: { rowNumber: 'asc' },
        },
      },
    });

    if (!source) {
      res.status(404).json({ error: 'Source not found.' });
      return;
    }

    res.json({ source });
  } catch (error: any) {
    console.error('Lead Intelligence getSourceDetail error:', error);
    res.status(500).json({ error: 'Failed to retrieve source details.' });
  }
}

/**
 * GET /api/lead-intelligence/leads
 */
export async function getLeads(req: Request, res: Response): Promise<void> {
  try {
    const user = OwnershipGuard.requireAdmin(req, res);
    if (!user) return;

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string, 10) || 25));
    const skip = (page - 1) * limit;

    const {
      search,
      sourceType,
      sourceId,
      batchId,
      dedupeStatus,
      resolutionStatus,
      hasEmail,
      hasPhone,
      hasDomain,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    const where: any = { userId: user.userId };

    if (sourceType && typeof sourceType === 'string') {
      where.sourceType = sourceType;
    }
    if (sourceId && typeof sourceId === 'string') {
      where.sourceId = sourceId;
    }
    if (batchId && typeof batchId === 'string') {
      where.batchId = batchId;
    }
    if (dedupeStatus && typeof dedupeStatus === 'string') {
      where.dedupeStatus = dedupeStatus;
    }
    if (resolutionStatus && typeof resolutionStatus === 'string' && resolutionStatus !== 'ALL') {
      where.resolutionStatus = resolutionStatus;
    }
    if (hasEmail === 'true') where.hasValidEmail = true;
    if (hasPhone === 'true') where.hasValidPhone = true;
    if (hasDomain === 'true') where.hasValidDomain = true;

    if (search && typeof search === 'string' && search.trim()) {
      const q = search.trim();
      where.OR = [
        { companyName: { contains: q, mode: 'insensitive' } },
        { contactName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { domain: { contains: q, mode: 'insensitive' } },
        { city: { contains: q, mode: 'insensitive' } },
        { boothNumber: { contains: q, mode: 'insensitive' } },
        { hallNumber: { contains: q, mode: 'insensitive' } },
        { category: { contains: q, mode: 'insensitive' } },
      ];
    }

    // Counts by status
    const [
      total,
      uniqueCount,
      duplicateCount,
      possibleCount,
      resolvedHighCount,
      resolvedMedCount,
      unresolvedCount,
      reviewRequiredCount,
      leads,
    ] = await Promise.all([
      prisma.leadIntelligenceLead.count({ where }),
      prisma.leadIntelligenceLead.count({ where: { ...where, dedupeStatus: 'UNIQUE' } }),
      prisma.leadIntelligenceLead.count({ where: { ...where, dedupeStatus: 'DUPLICATE' } }),
      prisma.leadIntelligenceLead.count({ where: { ...where, dedupeStatus: 'POSSIBLE_DUPLICATE' } }),
      prisma.leadIntelligenceLead.count({ where: { ...where, resolutionStatus: 'RESOLVED_HIGH' } }),
      prisma.leadIntelligenceLead.count({ where: { ...where, resolutionStatus: 'RESOLVED_MEDIUM' } }),
      prisma.leadIntelligenceLead.count({ where: { ...where, resolutionStatus: 'UNRESOLVED' } }),
      prisma.leadIntelligenceLead.count({ where: { ...where, resolutionStatus: 'REVIEW_REQUIRED' } }),
      prisma.leadIntelligenceLead.findMany({
        where,
        orderBy: { [sortBy as string]: sortOrder === 'asc' ? 'asc' : 'desc' },
        skip,
        take: limit,
      }),
    ]);

    res.json({
      leads,
      counts: {
        total,
        unique: uniqueCount,
        duplicate: duplicateCount,
        possibleDuplicate: possibleCount,
        resolvedHigh: resolvedHighCount,
        resolvedMedium: resolvedMedCount,
        domainsResolved: resolvedHighCount + resolvedMedCount,
        unresolved: unresolvedCount,
        reviewRequired: reviewRequiredCount,
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('Lead Intelligence getLeads error:', error);
    res.status(500).json({ error: 'Failed to retrieve leads.' });
  }
}

/**
 * GET /api/lead-intelligence/leads/:id
 */
export async function getLeadDetail(req: Request, res: Response): Promise<void> {
  try {
    const user = OwnershipGuard.requireAdmin(req, res);
    if (!user) return;

    const id = String(req.params.id);
    const lead = await prisma.leadIntelligenceLead.findFirst({
      where: { id, userId: user.userId },
      include: {
        source: {
          select: { id: true, name: true, sourceType: true, createdAt: true, url: true, originalFileName: true },
        },
        rawRecord: true,
      },
    });

    if (!lead) {
      res.status(404).json({ error: 'Lead record not found.' });
      return;
    }

    // If duplicate reference exists, fetch matched duplicate snippet
    let duplicateLead: any = null;
    if (lead.duplicateLeadId) {
      duplicateLead = await prisma.leadIntelligenceLead.findFirst({
        where: { id: lead.duplicateLeadId, userId: user.userId },
        select: {
          id: true,
          companyName: true,
          domain: true,
          email: true,
          phone: true,
          city: true,
          createdAt: true,
          sourceName: true,
        },
      });
    }

    res.json({ lead, duplicateMatch: duplicateLead });
  } catch (error: any) {
    console.error('Lead Intelligence getLeadDetail error:', error);
    res.status(500).json({ error: 'Failed to retrieve lead details.' });
  }
}

/**
 * POST /api/lead-intelligence/leads/:id/override-dedupe
 */
export async function overrideDedupeStatus(req: Request, res: Response): Promise<void> {
  try {
    const user = OwnershipGuard.requireAdmin(req, res);
    if (!user) return;

    const id = String(req.params.id);
    const { dedupeStatus } = req.body;

    if (!['UNIQUE', 'DUPLICATE', 'POSSIBLE_DUPLICATE'].includes(dedupeStatus)) {
      res.status(400).json({ error: 'Invalid dedupeStatus. Must be UNIQUE, DUPLICATE, or POSSIBLE_DUPLICATE.' });
      return;
    }

    const existing = await prisma.leadIntelligenceLead.findFirst({
      where: { id, userId: user.userId },
    });

    if (!existing) {
      res.status(404).json({ error: 'Lead record not found.' });
      return;
    }

    const updated = await prisma.leadIntelligenceLead.update({
      where: { id },
      data: {
        dedupeStatus,
        duplicateReason: dedupeStatus === 'UNIQUE' ? 'Manually marked as unique by user' : existing.duplicateReason,
      },
    });

    res.json({ success: true, lead: updated });
  } catch (error: any) {
    console.error('Lead Intelligence overrideDedupeStatus error:', error);
    res.status(500).json({ error: 'Failed to update dedupe status.' });
  }
}

/**
 * GET /api/lead-intelligence/export
 */
export async function exportLeadsCsv(req: Request, res: Response): Promise<void> {
  try {
    const user = OwnershipGuard.requireAdmin(req, res);
    if (!user) return;

    const { search, sourceType, sourceId, dedupeStatus } = req.query;

    const where: any = { userId: user.userId };
    if (sourceType && typeof sourceType === 'string') where.sourceType = sourceType;
    if (sourceId && typeof sourceId === 'string') where.sourceId = sourceId;
    if (dedupeStatus && typeof dedupeStatus === 'string') where.dedupeStatus = dedupeStatus;

    if (search && typeof search === 'string' && search.trim()) {
      const q = search.trim();
      where.OR = [
        { companyName: { contains: q, mode: 'insensitive' } },
        { contactName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { domain: { contains: q, mode: 'insensitive' } },
        { city: { contains: q, mode: 'insensitive' } },
      ];
    }

    const leads = await prisma.leadIntelligenceLead.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 10000, // Export up to 10k rows safely
    });

    const csvData = generateLeadsCsv(leads);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="lead_intelligence_export_${Date.now()}.csv"`);
    res.send(csvData);
  } catch (error: any) {
    console.error('Lead Intelligence export error:', error);
    res.status(500).json({ error: 'Failed to export leads.' });
  }
}

/**
 * GET /api/lead-intelligence/batches
 */
export async function getBatches(req: Request, res: Response): Promise<void> {
  try {
    const user = OwnershipGuard.requireAdmin(req, res);
    if (!user) return;

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const skip = (page - 1) * limit;

    const where: any = { userId: user.userId };
    if (req.query.status && typeof req.query.status === 'string' && req.query.status !== 'ALL') {
      where.status = req.query.status;
    }

    const [total, batches] = await Promise.all([
      prisma.leadIntelligenceResearchBatch.count({ where }),
      prisma.leadIntelligenceResearchBatch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          _count: {
            select: { leads: true },
          },
        },
      }),
    ]);

    res.json({
      batches,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('Lead Intelligence getBatches error:', error);
    res.status(500).json({ error: 'Failed to retrieve research batches.' });
  }
}

/**
 * GET /api/lead-intelligence/batches/:id
 */
export async function getBatchDetail(req: Request, res: Response): Promise<void> {
  try {
    const user = OwnershipGuard.requireAdmin(req, res);
    if (!user) return;

    const id = String(req.params.id);
    const batch = await prisma.leadIntelligenceResearchBatch.findFirst({
      where: { id, userId: user.userId },
      include: {
        source: true,
      },
    });

    if (!batch) {
      res.status(404).json({ error: 'Research batch not found.' });
      return;
    }

    const [
      totalRecords,
      uniqueCount,
      duplicateCount,
      possibleDuplicateCount,
      missingEmailCount,
      missingPhoneCount,
      resolvedCount,
      unresolvedCount,
      reviewCount,
      directoryDomainsCount,
    ] = await Promise.all([
      prisma.leadIntelligenceLead.count({ where: { batchId: id, userId: user.userId } }),
      prisma.leadIntelligenceLead.count({ where: { batchId: id, userId: user.userId, dedupeStatus: 'UNIQUE' } }),
      prisma.leadIntelligenceLead.count({ where: { batchId: id, userId: user.userId, dedupeStatus: 'DUPLICATE' } }),
      prisma.leadIntelligenceLead.count({ where: { batchId: id, userId: user.userId, dedupeStatus: 'POSSIBLE_DUPLICATE' } }),
      prisma.leadIntelligenceLead.count({ where: { batchId: id, userId: user.userId, email: null } }),
      prisma.leadIntelligenceLead.count({ where: { batchId: id, userId: user.userId, phone: null } }),
      prisma.leadIntelligenceLead.count({ where: { batchId: id, userId: user.userId, resolutionStatus: { in: ['RESOLVED_HIGH', 'RESOLVED_MEDIUM'] } } }),
      prisma.leadIntelligenceLead.count({ where: { batchId: id, userId: user.userId, resolutionStatus: 'UNRESOLVED' } }),
      prisma.leadIntelligenceLead.count({ where: { batchId: id, userId: user.userId, resolutionStatus: 'REVIEW_REQUIRED' } }),
      prisma.leadIntelligenceLead.count({ where: { batchId: id, userId: user.userId, resolutionSource: 'DIRECTORY' } }),
    ]);

    res.json({
      batch,
      summary: {
        totalRecords,
        uniqueRecords: uniqueCount,
        duplicateRecords: duplicateCount,
        possibleDuplicates: possibleDuplicateCount,
        missingEmail: missingEmailCount,
        missingPhone: missingPhoneCount,
        domainsResolved: batch.domainsResolved || resolvedCount,
        domainsUnresolved: batch.domainsUnresolved || unresolvedCount,
        reviewRequired: batch.reviewRequired || reviewCount,
        domainsFound: batch.domainsFound || directoryDomainsCount,
      },
    });
  } catch (error: any) {
    console.error('Lead Intelligence getBatchDetail error:', error);
    res.status(500).json({ error: 'Failed to retrieve batch detail.' });
  }
}

/**
 * POST /api/lead-intelligence/batches/:id/cancel
 */
export async function cancelBatch(req: Request, res: Response): Promise<void> {
  try {
    const user = OwnershipGuard.requireAdmin(req, res);
    if (!user) return;

    const id = String(req.params.id);
    const batch = await prisma.leadIntelligenceResearchBatch.findFirst({
      where: { id, userId: user.userId },
    });

    if (!batch) {
      res.status(404).json({ error: 'Research batch not found.' });
      return;
    }

    const updated = await prisma.leadIntelligenceResearchBatch.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
        errorMessage: 'Processing cancelled by user',
      },
    });

    res.json({ success: true, batch: updated });
  } catch (error: any) {
    console.error('Lead Intelligence cancelBatch error:', error);
    res.status(500).json({ error: 'Failed to cancel research batch.' });
  }
}

/**
 * GET /api/lead-intelligence/batches/:id/export
 * Clean 12-column Company-Level CSV Export for Sprint 1
 */
export async function exportBatchCsv(req: Request, res: Response): Promise<void> {
  try {
    const user = OwnershipGuard.requireAdmin(req, res);
    if (!user) return;

    const id = String(req.params.id);
    const batch = await prisma.leadIntelligenceResearchBatch.findFirst({
      where: { id, userId: user.userId },
    });

    if (!batch) {
      res.status(404).json({ error: 'Research batch not found.' });
      return;
    }

    // Batch-scoped export: fetch all company records belonging to this batch
    const leads = await prisma.leadIntelligenceLead.findMany({
      where: { batchId: id, userId: user.userId },
      orderBy: { createdAt: 'asc' },
      take: 10000,
    });

    const csvData = generateCompanyExhibitorCsv(leads, batch.sourceUrl);

    const safeName = batch.name.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 50);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_export.csv"`);
    res.send(csvData);
  } catch (error: any) {
    console.error('Lead Intelligence exportBatchCsv error:', error);
    res.status(500).json({ error: 'Failed to export batch leads.' });
  }
}

/**
 * POST /api/lead-intelligence/leads/:id/review-resolution
 * Human Review Override: Manually approve, correct, or reject company domain resolution
 */
export async function reviewCompanyResolution(req: Request, res: Response): Promise<void> {
  try {
    const user = OwnershipGuard.requireAdmin(req, res);
    if (!user) return;

    const id = String(req.params.id);
    const { resolutionStatus, domain, websiteUrl, notes } = req.body;

    const allowedStatuses = ['RESOLVED_HIGH', 'RESOLVED_MEDIUM', 'RESOLVED_LOW', 'REVIEW_REQUIRED', 'UNRESOLVED'];
    if (resolutionStatus && !allowedStatuses.includes(resolutionStatus)) {
      res.status(400).json({ error: `Invalid resolutionStatus. Must be one of: ${allowedStatuses.join(', ')}` });
      return;
    }

    const existing = await prisma.leadIntelligenceLead.findFirst({
      where: { id, userId: user.userId },
    });

    if (!existing) {
      res.status(404).json({ error: 'Lead record not found.' });
      return;
    }

    const cleanDomain = domain ? normalizeDomain(domain) : existing.domain;
    const cleanWebsite = websiteUrl?.trim() || (cleanDomain ? `https://${cleanDomain}` : existing.websiteUrl);

    const updated = await prisma.leadIntelligenceLead.update({
      where: { id },
      data: {
        resolutionStatus: resolutionStatus || existing.resolutionStatus,
        resolutionSource: 'MANUAL',
        domain: cleanDomain,
        websiteUrl: cleanWebsite,
        resolutionEvidence: {
          source: 'MANUAL',
          evidence: notes?.trim() || 'Manually reviewed and approved by human user',
          candidateDomain: cleanDomain,
        } as any,
        resolvedAt: new Date(),
        hasValidDomain: Boolean(cleanDomain),
      },
    });

    // Update batch counters if lead belongs to a batch
    if (existing.batchId) {
      const [resolvedHigh, resolvedMed, unresolved, reviewReq] = await Promise.all([
        prisma.leadIntelligenceLead.count({ where: { batchId: existing.batchId, resolutionStatus: 'RESOLVED_HIGH' } }),
        prisma.leadIntelligenceLead.count({ where: { batchId: existing.batchId, resolutionStatus: 'RESOLVED_MEDIUM' } }),
        prisma.leadIntelligenceLead.count({ where: { batchId: existing.batchId, resolutionStatus: 'UNRESOLVED' } }),
        prisma.leadIntelligenceLead.count({ where: { batchId: existing.batchId, resolutionStatus: 'REVIEW_REQUIRED' } }),
      ]);

      await prisma.leadIntelligenceResearchBatch.update({
        where: { id: existing.batchId },
        data: {
          domainsResolved: resolvedHigh + resolvedMed,
          domainsUnresolved: unresolved,
          reviewRequired: reviewReq,
          status: reviewReq > 0 ? 'REVIEW_REQUIRED' : 'COMPLETED',
        },
      }).catch(() => {});
    }

    res.json({ success: true, lead: updated });
  } catch (error: any) {
    console.error('Lead Intelligence reviewCompanyResolution error:', error);
    res.status(500).json({ error: 'Failed to update company resolution status.' });
  }
}

/**
 * DELETE /api/lead-intelligence/batches/:id
 */
export async function deleteBatch(req: Request, res: Response): Promise<void> {
  try {
    const user = OwnershipGuard.requireAdmin(req, res);
    if (!user) return;

    const id = String(req.params.id);
    const batch = await prisma.leadIntelligenceResearchBatch.findFirst({
      where: { id, userId: user.userId },
    });

    if (!batch) {
      res.status(404).json({ error: 'Research batch not found.' });
      return;
    }

    // Delete associated leads and batch
    await prisma.leadIntelligenceLead.deleteMany({
      where: { batchId: id, userId: user.userId },
    });

    await prisma.leadIntelligenceResearchBatch.delete({
      where: { id },
    });

    res.json({ success: true, message: 'Research batch and associated leads deleted successfully.' });
  } catch (error: any) {
    console.error('Lead Intelligence deleteBatch error:', error);
    res.status(500).json({ error: 'Failed to delete research batch.' });
  }
}
