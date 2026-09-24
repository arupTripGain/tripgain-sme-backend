import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { extractFromCsv, extractFromXlsx, extractFromPdf, extractFromPastedText, extractFromWebsite, ExtractionResult } from './extractionService';
import { normalizeLeadPayload } from './normalizationService';
import { evaluateDuplicate, createBatchDeduplicator } from './deduplicationService';
import { companyResolutionService } from './companyResolutionService';
import { tavilySearchResolver } from './search/tavilySearchResolver';

const prisma = new PrismaClient();

export interface ProcessSourceOptions {
  sourceId: string;
  batchId?: string | undefined;
  batchName?: string | undefined;
  userId: string;
  workspaceId?: string | null | undefined;
  fileBuffer?: Buffer | undefined;
  pastedText?: string | undefined;
  url?: string | undefined;
  sourceName: string;
  sourceType: 'CSV' | 'XLSX' | 'PDF' | 'PASTED_TEXT' | 'WEBSITE';
  maxRecords?: number | undefined;
  maxDetailPages?: number | undefined;
  maxRequests?: number | undefined;
  maxPages?: number | undefined;
  mode?: 'sample' | 'limited' | 'all' | undefined;
  allowLoopback?: boolean | undefined;
}

export async function processLeadIntelligencePipeline(options: ProcessSourceOptions) {
  const { 
    sourceId, batchId: initialBatchId, batchName, userId, workspaceId, fileBuffer, pastedText, url, sourceName, sourceType,
    maxRecords, maxDetailPages, maxRequests, maxPages, mode, allowLoopback
  } = options;

  // 1. Mark source as PROCESSING
  await prisma.leadIntelligenceSource.update({
    where: { id: sourceId },
    data: { status: 'PROCESSING' },
  });

  // 2. Initialize persistent Research Batch
  let batch: any = null;
  if (initialBatchId) {
    batch = await prisma.leadIntelligenceResearchBatch.findUnique({
      where: { id: initialBatchId },
    });
  }

  if (!batch) {
    batch = await prisma.leadIntelligenceResearchBatch.create({
      data: {
        userId,
        workspaceId: workspaceId || null,
        sourceId,
        sourceUrl: url || null,
        name: batchName || sourceName || 'Research Batch',
        status: 'DISCOVERING',
      },
    });
  } else {
    await prisma.leadIntelligenceResearchBatch.update({
      where: { id: batch.id },
      data: { status: 'DISCOVERING' },
    });
  }

  // Live progress callback
  const onProgress = async (prog: any) => {
    try {
      await prisma.leadIntelligenceResearchBatch.update({
        where: { id: batch.id },
        data: {
          totalPages: prog.totalPages || 1,
          pagesProcessed: prog.pagesProcessed || 0,
          recordsDiscovered: prog.recordsDiscovered || 0,
          recordsProcessed: prog.recordsProcessed || 0,
          uniqueRecords: prog.uniqueRecords || 0,
          duplicateRecords: prog.duplicateRecords || 0,
          failedRecords: prog.failedRecords || 0,
          requestCount: prog.requestsMade || 0,
          status: prog.status || 'EXTRACTING',
        },
      });
    } catch {}
  };

  const checkCancelled = async () => {
    try {
      const b = await prisma.leadIntelligenceResearchBatch.findUnique({
        where: { id: batch.id },
        select: { status: true },
      });
      return b?.status === 'CANCELLED';
    } catch {
      return false;
    }
  };

  try {
    let extraction: ExtractionResult;

    await prisma.leadIntelligenceResearchBatch.update({
      where: { id: batch.id },
      data: { status: 'EXTRACTING' },
    }).catch(() => {});

    switch (sourceType) {
      case 'CSV':
        if (!fileBuffer) throw new Error('No CSV file buffer provided');
        extraction = extractFromCsv(fileBuffer, sourceName);
        break;

      case 'XLSX':
        if (!fileBuffer) throw new Error('No XLSX file buffer provided');
        extraction = extractFromXlsx(fileBuffer, sourceName);
        break;

      case 'PDF':
        if (!fileBuffer) throw new Error('No PDF file buffer provided');
        extraction = await extractFromPdf(fileBuffer, sourceName);
        break;

      case 'PASTED_TEXT':
        if (!pastedText) throw new Error('No pasted text provided');
        extraction = extractFromPastedText(pastedText, sourceName);
        break;

      case 'WEBSITE':
        if (!url) throw new Error('No URL provided');
        extraction = await extractFromWebsite(url, sourceName, {
          maxRecords,
          maxDetailPages,
          maxRequests,
          maxPages,
          mode,
          allowLoopback,
          onProgress,
          checkCancelled,
        });
        break;

      default:
        throw new Error(`Unsupported source type: ${sourceType}`);
    }

    // Handle Needs OCR or complete extraction failure
    if (extraction.status === 'NEEDS_OCR') {
      await prisma.leadIntelligenceSource.update({
        where: { id: sourceId },
        data: {
          status: 'FAILED',
          errorMessage: extraction.errorMessage || 'Needs OCR: Scanned PDF without extractable text.',
          errorCount: 1,
        },
      });

      const firstRaw = extraction.rawRecords[0];
      if (firstRaw) {
        await prisma.leadIntelligenceRawRecord.create({
          data: {
            sourceId,
            userId,
            rowNumber: 1,
            rawText: firstRaw.rawText || null,
            parseStatus: 'NEEDS_OCR',
            errorMessage: extraction.errorMessage || null,
          },
        });
      }

      return {
        status: 'NEEDS_OCR',
        totalRecords: 0,
        validCount: 0,
        duplicateCount: 0,
        errorCount: 1,
        errorMessage: extraction.errorMessage,
      };
    }

    if (extraction.status === 'FAILED' && extraction.leads.length === 0) {
      await prisma.leadIntelligenceSource.update({
        where: { id: sourceId },
        data: {
          status: 'FAILED',
          errorMessage: extraction.errorMessage || 'Failed to extract any leads from source.',
          errorCount: extraction.totalRecords || 1,
        },
      });

      return {
        status: 'FAILED',
        totalRecords: extraction.totalRecords,
        validCount: 0,
        duplicateCount: 0,
        errorCount: extraction.totalRecords || 1,
        errorMessage: extraction.errorMessage,
      };
    }

    // 2. Normalizing & Deduplicating Stage
    await prisma.leadIntelligenceResearchBatch.update({
      where: { id: batch.id },
      data: { status: 'NORMALIZING' },
    }).catch(() => {});

    let validCount = 0;
    let duplicateCount = 0;
    let errorCount = 0;

    let domainsFound = 0;
    let domainsResolved = 0;
    let domainsUnresolved = 0;
    let reviewRequired = 0;

    const deduplicator = await createBatchDeduplicator(userId, workspaceId);

    // Map extracted leads by rowNumber for O(1) matching
    const leadsByRow = new Map<number, typeof extraction.leads[0]>();
    for (const lead of extraction.leads) {
      if (lead.rowNumber) leadsByRow.set(lead.rowNumber, lead);
    }

    const rawRecordsToInsert: any[] = [];
    const normalizedLeads: any[] = [];

    for (let i = 0; i < extraction.rawRecords.length; i++) {
      const raw = extraction.rawRecords[i];
      if (!raw) continue;

      const rowNumber = raw.rowNumber || i + 1;
      const rawRecordId = crypto.randomUUID();

      rawRecordsToInsert.push({
        id: rawRecordId,
        sourceId,
        userId,
        rowNumber,
        rawText: raw.rawText ? String(raw.rawText).slice(0, 5000) : null,
        rawData: raw.rawData || undefined,
        parseStatus: raw.parseStatus,
        errorMessage: raw.errorMessage || null,
      });

      // Find matching extracted lead for this raw row
      const leadItem = leadsByRow.get(rowNumber) || extraction.leads[i];
      if (!leadItem || !leadItem.companyName) {
        if (raw.parseStatus === 'FAILED') errorCount++;
        continue;
      }

      // 3. Normalization pass
      const normalized = normalizeLeadPayload({
        rawName: leadItem.rawName || leadItem.companyName,
        companyName: leadItem.companyName,
        boothNumber: leadItem.boothNumber,
        hallNumber: leadItem.hallNumber,
        category: leadItem.category,
        detailUrl: leadItem.detailUrl,
        sourceUrl: leadItem.sourceUrl || url,
        domain: leadItem.domain || leadItem.websiteUrl || undefined,
        websiteUrl: leadItem.websiteUrl || undefined,
        contactName: leadItem.contactName || undefined,
        contactTitle: leadItem.contactTitle || undefined,
        email: leadItem.email || undefined,
        phone: leadItem.phone || undefined,
        city: leadItem.city || undefined,
        state: leadItem.state || undefined,
        country: leadItem.country || undefined,
        address: leadItem.address || undefined,
        industry: leadItem.industry || undefined,
        companySize: leadItem.companySize || undefined,
        linkedinUrl: leadItem.linkedinUrl || undefined,
        sourceType,
        sourceName,
        provenance: {
          ...leadItem.provenance,
          sourceId,
          rawRecordId,
        },
      });

      normalizedLeads.push({
        leadItem,
        normalized,
        rawRecordId,
      });
    }

    // 4. Deduplication Stage
    await prisma.leadIntelligenceResearchBatch.update({
      where: { id: batch.id },
      data: { status: 'DEDUPLICATING' },
    }).catch(() => {});

    const deduplicatedItems: any[] = [];
    for (const item of normalizedLeads) {
      const { normalized, rawRecordId, leadItem } = item;
      const dedupe = deduplicator.evaluate({
        domain: normalized.domain,
        email: normalized.email,
        companyNormalizedName: normalized.companyNormalizedName,
        companyName: normalized.companyName,
        city: normalized.city,
        phone: normalized.phone,
      });

      const leadId = crypto.randomUUID();

      if (dedupe.dedupeStatus === 'DUPLICATE') {
        duplicateCount++;
      } else {
        validCount++;
        deduplicator.addRecord({
          id: leadId,
          domain: normalized.domain,
          email: normalized.email,
          companyNormalizedName: normalized.companyNormalizedName,
          companyName: normalized.companyName,
          city: normalized.city,
          phone: normalized.phone,
        });
      }

      deduplicatedItems.push({
        leadId,
        leadItem,
        normalized,
        rawRecordId,
        dedupe,
      });
    }

    // 5. Company Domain Resolution Stage
    await prisma.leadIntelligenceResearchBatch.update({
      where: { id: batch.id },
      data: { status: 'RESOLVING_DOMAINS' },
    }).catch(() => {});

    companyResolutionService.clearCache();
    const leadsToInsert: any[] = [];

    for (const item of deduplicatedItems) {
      const { leadId, leadItem, normalized, rawRecordId, dedupe } = item;

      // Run evidence-based company resolution
      const resolution = await companyResolutionService.resolveCompany({
        rawName: normalized.rawName,
        companyName: normalized.companyName,
        companyNormalizedName: normalized.companyNormalizedName,
        websiteUrl: normalized.websiteUrl,
        domain: normalized.domain,
        city: normalized.city,
        category: normalized.category,
        sourceUrl: normalized.sourceUrl,
        userId,
        workspaceId: workspaceId || null,
        searchResolver: tavilySearchResolver,
      });

      // Update counters based on resolution evidence
      if (resolution.resolutionSource === 'DIRECTORY') {
        domainsFound++;
      }
      if (resolution.resolutionStatus === 'RESOLVED_HIGH' || resolution.resolutionStatus === 'RESOLVED_MEDIUM') {
        domainsResolved++;
      } else if (resolution.resolutionStatus === 'REVIEW_REQUIRED') {
        reviewRequired++;
      } else if (resolution.resolutionStatus === 'UNRESOLVED') {
        domainsUnresolved++;
      }

      leadsToInsert.push({
        id: leadId,
        userId,
        workspaceId: workspaceId || null,
        sourceId,
        batchId: batch.id,
        rawRecordId,
        rawName: normalized.rawName,
        companyName: normalized.companyName,
        companyNormalizedName: normalized.companyNormalizedName,
        domain: resolution.domain || normalized.domain,
        websiteUrl: resolution.websiteUrl || normalized.websiteUrl,
        boothNumber: normalized.boothNumber,
        hallNumber: normalized.hallNumber,
        category: normalized.category,
        detailUrl: normalized.detailUrl,
        sourceUrl: normalized.sourceUrl,
        resolutionStatus: resolution.resolutionStatus,
        resolutionSource: resolution.resolutionSource,
        resolutionEvidence: resolution.resolutionEvidence as any,
        resolvedAt: resolution.resolvedAt,
        industry: normalized.industry,
        companySize: normalized.companySize,
        contactName: normalized.contactName,
        contactTitle: normalized.contactTitle,
        email: normalized.email,
        phone: normalized.phone,
        linkedinUrl: normalized.linkedinUrl,
        city: normalized.city,
        state: normalized.state,
        country: normalized.country,
        address: normalized.address,
        sourceType,
        sourceName,
        provenance: normalized.provenance,
        dedupeStatus: dedupe.dedupeStatus,
        duplicateConfidence: dedupe.duplicateConfidence,
        duplicateReason: dedupe.duplicateReason,
        duplicateLeadId: dedupe.duplicateLeadId,
        hasValidEmail: normalized.hasValidEmail,
        hasValidPhone: normalized.hasValidPhone,
        hasValidDomain: Boolean(resolution.domain || normalized.hasValidDomain),
        completenessScore: normalized.completenessScore,
      });
    }

    // 6. Bulk insert Raw Records in chunks of 200
    const CHUNK_SIZE = 200;
    for (let c = 0; c < rawRecordsToInsert.length; c += CHUNK_SIZE) {
      const chunk = rawRecordsToInsert.slice(c, c + CHUNK_SIZE);
      await prisma.leadIntelligenceRawRecord.createMany({ data: chunk });
    }

    // Check existing leads in batch to prevent duplication upon resume/worker restart
    const existingLeadsInBatch = await prisma.leadIntelligenceLead.findMany({
      where: { batchId: batch.id },
      select: { companyNormalizedName: true, domain: true },
    });
    const existingCompanyNames = new Set(
      existingLeadsInBatch.map((l) => l.companyNormalizedName).filter(Boolean) as string[]
    );
    const existingDomains = new Set(
      existingLeadsInBatch.map((l) => l.domain).filter(Boolean) as string[]
    );

    const newLeadsToInsert = leadsToInsert.filter((l) => {
      if (l.companyNormalizedName && existingCompanyNames.has(l.companyNormalizedName)) {
        return false;
      }
      if (l.domain && existingDomains.has(l.domain)) {
        return false;
      }
      if (l.companyNormalizedName) existingCompanyNames.add(l.companyNormalizedName);
      if (l.domain) existingDomains.add(l.domain);
      return true;
    });

    // 7. Bulk insert Leads in chunks of 200
    for (let c = 0; c < newLeadsToInsert.length; c += CHUNK_SIZE) {
      const chunk = newLeadsToInsert.slice(c, c + CHUNK_SIZE);
      await prisma.leadIntelligenceLead.createMany({ data: chunk });
    }

    const finalStatus = errorCount > 0 && validCount > 0 ? 'PARTIAL' : (validCount > 0 || duplicateCount > 0 ? 'COMPLETED' : 'FAILED');

    // 8. Update Source counts and final status
    await prisma.leadIntelligenceSource.update({
      where: { id: sourceId },
      data: {
        status: finalStatus,
        recordCount: validCount + duplicateCount + errorCount,
        validCount,
        duplicateCount,
        errorCount,
        errorMessage: errorCount > 0 ? `${errorCount} row(s) failed validation` : null,
      },
    });

    const finalBatchStatus = reviewRequired > 0 ? 'REVIEW_REQUIRED' : finalStatus;

    // 9. Update Research Batch with complete final statistics
    await prisma.leadIntelligenceResearchBatch.update({
      where: { id: batch.id },
      data: {
        status: finalBatchStatus,
        completedAt: new Date(),
        totalPages: extraction.metrics?.totalPages || 1,
        pagesProcessed: extraction.metrics?.pagesProcessed || 1,
        recordsDiscovered: extraction.metrics?.recordsDiscovered || (validCount + duplicateCount + errorCount),
        recordsProcessed: validCount + duplicateCount + errorCount,
        uniqueRecords: validCount,
        duplicateRecords: duplicateCount,
        domainsFound,
        domainsResolved,
        domainsUnresolved,
        reviewRequired,
        failedRecords: errorCount + (extraction.metrics?.failedPages || 0),
        requestCount: extraction.metrics?.requestsMade || 1,
        errorMessage: extraction.errorMessage || (errorCount > 0 ? `${errorCount} row(s) failed validation` : null),
      },
    });

    return {
      status: finalBatchStatus,
      batchId: batch.id,
      totalRecords: validCount + duplicateCount + errorCount,
      validCount,
      duplicateCount,
      errorCount,
      domainsFound,
      domainsResolved,
      domainsUnresolved,
      reviewRequired,
      metrics: extraction.metrics,
      pageType: extraction.pageType,
    };
  } catch (err: any) {
    await prisma.leadIntelligenceSource.update({
      where: { id: sourceId },
      data: {
        status: 'FAILED',
        errorMessage: err.message,
      },
    }).catch(() => {});

    if (batch?.id) {
      await prisma.leadIntelligenceResearchBatch.update({
        where: { id: batch.id },
        data: {
          status: 'FAILED',
          errorMessage: err.message,
          completedAt: new Date(),
        },
      }).catch(() => {});
    }
    throw err;
  }
}
