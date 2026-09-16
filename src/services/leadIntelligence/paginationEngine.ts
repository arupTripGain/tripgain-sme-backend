import { URL } from 'url';
import * as cheerio from 'cheerio';
import { Page } from 'playwright';
import { validateHopUrl, fetchPublicUrl } from './urlFetcherService';
import { findRecordArray } from './playwrightService';
import { mapJsonRecordToLead, CandidateCard, extractCardsFromHtml, isDirectoryOrganizerName } from './directoryExtractor';
import { ExtractedRawLead } from './extractionService';
import { normalizeCompanyName, normalizeDomain } from './normalizationService';

export type PaginationStrategy =
  | 'API_QUERY'
  | 'API_BODY'
  | 'DOM_NEXT'
  | 'LOAD_MORE'
  | 'URL_QUERY'
  | 'URL_PATH'
  | 'OFFSET'
  | 'NONE';

export interface PaginationLimits {
  maxRecords?: number;
  maxPages?: number;
  maxDetailPages?: number;
  maxRequests?: number;
}

export const DEFAULT_SAFETY_LIMITS: Required<PaginationLimits> = {
  maxRecords: 5000,
  maxPages: 500,
  maxDetailPages: 5000,
  maxRequests: 10000,
};

export interface PaginationProgress {
  strategy: PaginationStrategy;
  totalPages: number;
  pagesProcessed: number;
  recordsDiscovered: number;
  recordsProcessed: number;
  uniqueRecords: number;
  duplicateRecords: number;
  failedRecords: number;
  requestsMade: number;
  status: 'DISCOVERING' | 'EXTRACTING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
  stopReason?: string;
  safetyLimitReached?: boolean;
}

export type ProgressCallback = (progress: PaginationProgress) => void | Promise<void>;
export type CheckCancelledCallback = () => Promise<boolean> | boolean;

export interface DiscoveredApiPattern {
  url: string;
  baseUrl: string;
  method: 'GET' | 'POST';
  queryParams: Record<string, string>;
  bodyParams?: Record<string, any> | undefined;
  pageParamName: string;
  limitParamName?: string | undefined;
  pageSize: number;
  currentPage: number;
  totalPages: number;
  totalRecords?: number | undefined;
  isZeroIndexed: boolean;
  isOffsetBased: boolean;
  requestHeaders?: Record<string, string> | undefined;
}

/**
 * Inspects intercepted API responses to detect if a background JSON endpoint is paginated
 */
export function detectApiPaginationPattern(
  capturedResponses: Array<{ url: string; data: any; rawResponse?: any; method?: string; postData?: any; headers?: Record<string, string> }>
): DiscoveredApiPattern | null {
  for (const item of capturedResponses) {
    if (!item.url || !item.data) continue;

    let totalPages = 1;
    let totalRecords = 0;
    let currentPage = 1;
    let pageSize = 20;

    const raw = item.rawResponse || {};
    // Look for common metadata envelopes: { totalPages, totalElements, data: { ... } }
    const inspectCandidates = [raw, raw.data, raw.pagination, raw.meta, raw.paging, raw.info].filter(Boolean);

    for (const c of inspectCandidates) {
      if (typeof c === 'object') {
        if (typeof c.totalPages === 'number') totalPages = c.totalPages;
        else if (typeof c.total_pages === 'number') totalPages = c.total_pages;
        else if (typeof c.pageCount === 'number') totalPages = c.pageCount;
        else if (typeof c.page_count === 'number') totalPages = c.page_count;

        if (typeof c.totalElements === 'number') totalRecords = c.totalElements;
        else if (typeof c.total_elements === 'number') totalRecords = c.total_elements;
        else if (typeof c.totalRecords === 'number') totalRecords = c.totalRecords;
        else if (typeof c.total_records === 'number') totalRecords = c.total_records;
        else if (typeof c.total === 'number') totalRecords = c.total;
        else if (typeof c.totalCount === 'number') totalRecords = c.totalCount;
        else if (typeof c.count === 'number' && c.count > 50) totalRecords = c.count;

        if (typeof c.pageNumber === 'number') currentPage = c.pageNumber;
        else if (typeof c.page === 'number') currentPage = c.page;
        else if (typeof c.currentPage === 'number') currentPage = c.currentPage;

        if (typeof c.pageSize === 'number') pageSize = c.pageSize;
        else if (typeof c.page_size === 'number') pageSize = c.page_size;
        else if (typeof c.limit === 'number') pageSize = c.limit;
        else if (typeof c.per_page === 'number') pageSize = c.per_page;
      }
    }

    // Inspect URL query parameters
    try {
      const parsedUrl = new URL(item.url);
      const queryParams: Record<string, string> = {};
      parsedUrl.searchParams.forEach((v, k) => { queryParams[k] = v; });

      // Check query parameter names for page/offset
      const pageKey = Object.keys(queryParams).find(k => /^(pagenumber|page_number|page_no|pageno|page|p)$/i.test(k));
      const offsetKey = Object.keys(queryParams).find(k => /^(offset|start|skip)$/i.test(k));
      const limitKey = Object.keys(queryParams).find(k => /^(pagesize|page_size|limit|per_page|size|rows)$/i.test(k));

      if (limitKey && queryParams[limitKey]) {
        const parsedLimit = parseInt(String(queryParams[limitKey]), 10);
        if (!isNaN(parsedLimit) && parsedLimit > 0) pageSize = parsedLimit;
      }

      if (pageKey && queryParams[pageKey]) {
        const val = parseInt(String(queryParams[pageKey]), 10) || currentPage;
        const isZeroIndexed = val === 0;
        if (totalRecords > 0 && totalPages <= 1 && pageSize > 0) {
          totalPages = Math.ceil(totalRecords / pageSize);
        }

        if (totalPages > 1 || (totalRecords > pageSize)) {
          return {
            url: item.url,
            baseUrl: `${parsedUrl.origin}${parsedUrl.pathname}`,
            method: 'GET',
            queryParams,
            pageParamName: pageKey,
            limitParamName: limitKey || undefined,
            pageSize,
            currentPage: val,
            totalPages: Math.max(totalPages, totalRecords > 0 ? Math.ceil(totalRecords / pageSize) : 2),
            totalRecords: totalRecords || undefined,
            isZeroIndexed,
            isOffsetBased: false,
            requestHeaders: item.headers || undefined,
          };
        }
      } else if (offsetKey && queryParams[offsetKey]) {
        const val = parseInt(String(queryParams[offsetKey]), 10) || 0;
        if (totalRecords > 0 && totalPages <= 1 && pageSize > 0) {
          totalPages = Math.ceil(totalRecords / pageSize);
        }
        if (totalPages > 1 || totalRecords > pageSize) {
          return {
            url: item.url,
            baseUrl: `${parsedUrl.origin}${parsedUrl.pathname}`,
            method: 'GET',
            queryParams,
            pageParamName: offsetKey,
            limitParamName: limitKey || undefined,
            pageSize,
            currentPage: Math.floor(val / pageSize) + 1,
            totalPages: Math.max(totalPages, totalRecords > 0 ? Math.ceil(totalRecords / pageSize) : 2),
            totalRecords: totalRecords || undefined,
            isZeroIndexed: true,
            isOffsetBased: true,
            requestHeaders: item.headers || undefined,
          };
        }
      }
    } catch {}
  }

  return null;
}

/**
 * Paginates an API endpoint directly using SSRF-validated HTTP fetch calls
 */
export async function paginateApiEndpoint(
  pattern: DiscoveredApiPattern,
  baseOriginUrl: string,
  organizerEmails: string[],
  limits: Required<PaginationLimits>,
  onProgress?: ProgressCallback,
  checkCancelled?: CheckCancelledCallback,
  allowLoopback?: boolean
): Promise<{
  leads: Partial<ExtractedRawLead>[];
  progress: PaginationProgress;
}> {
  const leads: Partial<ExtractedRawLead>[] = [];
  const seenDedupeKeys = new Set<string>();

  const progress: PaginationProgress = {
    strategy: pattern.isOffsetBased ? 'OFFSET' : 'API_QUERY',
    totalPages: pattern.totalPages,
    pagesProcessed: 0,
    recordsDiscovered: 0,
    recordsProcessed: 0,
    uniqueRecords: 0,
    duplicateRecords: 0,
    failedRecords: 0,
    requestsMade: 0,
    status: 'EXTRACTING',
  };

  const startPage = pattern.isZeroIndexed ? 0 : 1;
  const maxPageTarget = pattern.isZeroIndexed 
    ? Math.min(pattern.totalPages - 1, limits.maxPages - 1)
    : Math.min(pattern.totalPages, limits.maxPages);

  for (let p = startPage; p <= maxPageTarget; p++) {
    // Check cancellation
    if (checkCancelled && await checkCancelled()) {
      progress.status = 'CANCELLED';
      progress.stopReason = 'Operation cancelled by user';
      if (onProgress) await onProgress(progress);
      break;
    }

    // Check safety limits
    if (progress.recordsDiscovered >= limits.maxRecords) {
      progress.safetyLimitReached = true;
      progress.stopReason = `Safety limit reached: maximum record ceiling (${limits.maxRecords}) reached.`;
      break;
    }
    if (progress.requestsMade >= limits.maxRequests) {
      progress.safetyLimitReached = true;
      progress.stopReason = `Safety limit reached: maximum request ceiling (${limits.maxRequests}) reached.`;
      break;
    }

    // Build URL for current page
    const nextUrl = new URL(pattern.baseUrl);
    Object.entries(pattern.queryParams).forEach(([k, v]) => {
      if (k === pattern.pageParamName) {
        if (pattern.isOffsetBased) {
          const offsetVal = (p - (pattern.isZeroIndexed ? 0 : 1)) * pattern.pageSize;
          nextUrl.searchParams.set(k, String(offsetVal));
        } else {
          nextUrl.searchParams.set(k, String(p));
        }
      } else {
        nextUrl.searchParams.set(k, v);
      }
    });

    const targetUrlStr = nextUrl.toString();

    // Strict SSRF validation on target URL
    try {
      await validateHopUrl(targetUrlStr, baseOriginUrl, { allowLoopback });
    } catch (err: any) {
      console.warn(`SSRF validation blocked API pagination hop to ${targetUrlStr}:`, err.message);
      progress.failedRecords++;
      break;
    }

    progress.requestsMade++;

    let items: any[] = [];
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      };
      if (pattern.requestHeaders) {
        if (pattern.requestHeaders['authorization']) headers['Authorization'] = pattern.requestHeaders['authorization'];
        if (pattern.requestHeaders['accept-language']) headers['Accept-Language'] = pattern.requestHeaders['accept-language'];
      }

      const res = await fetch(targetUrlStr, { headers });
      if (!res.ok) {
        progress.failedRecords++;
        continue;
      }
      const json = await res.json();
      const records = findRecordArray(json);
      if (Array.isArray(records)) {
        items = records;
      }
    } catch (err: any) {
      progress.failedRecords++;
      continue;
    }

    if (items.length === 0) {
      // No more records on page
      break;
    }

    let newRecordsThisPage = 0;
    for (const item of items) {
      if (progress.recordsDiscovered >= limits.maxRecords) break;

      progress.recordsDiscovered++;
      const mapped = mapJsonRecordToLead(item, targetUrlStr, baseOriginUrl, organizerEmails);
      if (mapped && mapped.companyName && !isDirectoryOrganizerName(mapped.companyName)) {
        progress.recordsProcessed++;
        const normName = normalizeCompanyName(mapped.companyName);
        const normDomain = normalizeDomain(mapped.domain || mapped.websiteUrl || undefined);
        const dedupeKey = normDomain || normName;

        if (seenDedupeKeys.has(dedupeKey)) {
          progress.duplicateRecords++;
        } else {
          seenDedupeKeys.add(dedupeKey);
          progress.uniqueRecords++;
          leads.push(mapped);
          newRecordsThisPage++;
        }
      }
    }

    progress.pagesProcessed++;

    if (onProgress) {
      await onProgress(progress);
    }

    // Stop if page yielded 0 new unique records and we've processed multiple pages (loop detection)
    if (newRecordsThisPage === 0 && progress.pagesProcessed > 2) {
      progress.stopReason = 'No new records discovered on page, stopping pagination.';
      break;
    }
  }

  return { leads, progress };
}

/**
 * Paginates dynamic client-side SPA directories by clicking "Next" button in Playwright
 */
export async function paginateDomNext(
  page: Page,
  baseOriginUrl: string,
  organizerEmails: string[],
  organizerPhones: string[],
  limits: Required<PaginationLimits>,
  onProgress?: ProgressCallback,
  checkCancelled?: CheckCancelledCallback
): Promise<{
  cards: CandidateCard[];
  progress: PaginationProgress;
}> {
  const allCards: CandidateCard[] = [];
  const seenCardFingerprints = new Set<string>();

  const progress: PaginationProgress = {
    strategy: 'DOM_NEXT',
    totalPages: 1,
    pagesProcessed: 0,
    recordsDiscovered: 0,
    recordsProcessed: 0,
    uniqueRecords: 0,
    duplicateRecords: 0,
    failedRecords: 0,
    requestsMade: 1,
    status: 'EXTRACTING',
  };

  const nextButtonSelectors = [
    'button:has-text("Next")',
    'button[aria-label*="Next" i]',
    'a[aria-label*="Next" i]',
    'li:not(.disabled):not(.active) > a:has-text("Next")',
    'li.next:not(.disabled) > a',
    '[rel="next"]',
    'button:has-text("Load More")',
    'button:has-text("Show More")',
    'button:has-text(">")',
    'nav[aria-label*="pagination" i] button:not([disabled])',
  ];

  let currentPageNum = 1;

  while (currentPageNum <= limits.maxPages) {
    if (checkCancelled && await checkCancelled()) {
      progress.status = 'CANCELLED';
      progress.stopReason = 'Operation cancelled by user';
      break;
    }

    if (progress.recordsDiscovered >= limits.maxRecords) {
      progress.safetyLimitReached = true;
      progress.stopReason = `Safety limit reached: maximum record ceiling (${limits.maxRecords}) reached.`;
      break;
    }
    if (progress.requestsMade >= limits.maxRequests) {
      progress.safetyLimitReached = true;
      progress.stopReason = `Safety limit reached: maximum request ceiling (${limits.maxRequests}) reached.`;
      break;
    }

    // Extract cards from current DOM
    const currentHtml = await page.content();
    const currentUrl = page.url();
    const pageCards = extractCardsFromHtml(currentHtml, currentUrl, organizerEmails, organizerPhones);

    let newCardsCount = 0;
    const pageFingerprints: string[] = [];

    for (const card of pageCards) {
      if (!card.companyName || isDirectoryOrganizerName(card.companyName)) continue;
      const fp = `${card.companyName.toLowerCase().trim()}|${(card.city || '').toLowerCase().trim()}`;
      pageFingerprints.push(fp);

      progress.recordsDiscovered++;
      if (seenCardFingerprints.has(fp)) {
        progress.duplicateRecords++;
      } else {
        seenCardFingerprints.add(fp);
        progress.uniqueRecords++;
        progress.recordsProcessed++;
        allCards.push(card);
        newCardsCount++;
      }
    }

    progress.pagesProcessed = currentPageNum;
    if (onProgress) await onProgress(progress);

    if (newCardsCount === 0 && currentPageNum > 1) {
      progress.stopReason = 'No new records discovered on page.';
      break;
    }

    if (currentPageNum >= limits.maxPages) {
      let nextBtnExists = false;
      for (const sel of nextButtonSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.count() > 0 && await btn.isVisible()) {
            nextBtnExists = true;
            break;
          }
        } catch {}
      }
      if (nextBtnExists) {
        progress.safetyLimitReached = true;
        progress.stopReason = `Configured maximum pages limit (${limits.maxPages}) reached.`;
      }
      break;
    }

    // Look for Next button
    let nextButtonFound = false;
    for (const sel of nextButtonSelectors) {
      try {
        const btn = page.locator(sel).first();
        const count = await btn.count();
        if (count > 0 && await btn.isVisible()) {
          const isDisabled = await btn.isDisabled().catch(() => false);
          const ariaDisabled = await btn.getAttribute('aria-disabled').catch(() => null);
          const className = await btn.getAttribute('class').catch(() => '') || '';

          if (!isDisabled && ariaDisabled !== 'true' && !className.includes('disabled')) {
            // Click Next
            await btn.click({ timeout: 5000 });
            progress.requestsMade++;
            nextButtonFound = true;

            // Wait for content mutation or network idle
            await page.waitForTimeout(2000);
            break;
          }
        }
      } catch {}
    }

    if (!nextButtonFound) {
      progress.stopReason = 'No next button found or next button disabled.';
      break;
    }

    currentPageNum++;
  }

  return { cards: allCards, progress };
}

/**
 * Paginates static HTML directories by following next links (<a rel="next"> or numbered links)
 */
export async function paginateStaticHtml(
  initialHtml: string,
  initialUrl: string,
  organizerEmails: string[],
  organizerPhones: string[],
  limits: Required<PaginationLimits>,
  onProgress?: ProgressCallback,
  checkCancelled?: CheckCancelledCallback,
  allowLoopback?: boolean
): Promise<{
  cards: CandidateCard[];
  progress: PaginationProgress;
}> {
  const allCards: CandidateCard[] = [];
  const seenCardFingerprints = new Set<string>();
  const visitedUrls = new Set<string>([initialUrl]);

  let currentHtml = initialHtml;
  let currentUrl = initialUrl;
  let currentPage = 1;

  const progress: PaginationProgress = {
    strategy: 'URL_QUERY',
    totalPages: 1,
    pagesProcessed: 0,
    recordsDiscovered: 0,
    recordsProcessed: 0,
    uniqueRecords: 0,
    duplicateRecords: 0,
    failedRecords: 0,
    requestsMade: 1,
    status: 'EXTRACTING',
  };

  while (currentPage <= limits.maxPages) {
    if (checkCancelled && await checkCancelled()) {
      progress.status = 'CANCELLED';
      progress.stopReason = 'Operation cancelled by user';
      break;
    }

    if (progress.recordsDiscovered >= limits.maxRecords) {
      progress.safetyLimitReached = true;
      progress.stopReason = `Safety limit reached: maximum record ceiling (${limits.maxRecords}) reached.`;
      break;
    }

    const cards = extractCardsFromHtml(currentHtml, currentUrl, organizerEmails, organizerPhones);
    let newCardsCount = 0;

    for (const card of cards) {
      if (!card.companyName || isDirectoryOrganizerName(card.companyName)) continue;
      const fp = `${card.companyName.toLowerCase().trim()}|${(card.city || '').toLowerCase().trim()}`;

      progress.recordsDiscovered++;
      if (seenCardFingerprints.has(fp)) {
        progress.duplicateRecords++;
      } else {
        seenCardFingerprints.add(fp);
        progress.uniqueRecords++;
        progress.recordsProcessed++;
        allCards.push(card);
        newCardsCount++;
      }
    }

    progress.pagesProcessed = currentPage;
    if (onProgress) await onProgress(progress);

    // Look for next URL in HTML
    const $ = cheerio.load(currentHtml);
    let nextHref: string | undefined;

    // 1. rel="next"
    const relNext = $('a[rel="next"], link[rel="next"]').attr('href');
    if (relNext) nextHref = relNext;

    // 2. Class next
    if (!nextHref) {
      nextHref = $('a.next, .pagination a:contains("Next"), .pagination a:contains(">"), li.next a').attr('href');
    }

    // 3. Numbered pagination link for currentPage + 1
    if (!nextHref) {
      const nextPageStr = String(currentPage + 1);
      $('a').each((_, el) => {
        const text = $(el).text().trim();
        if (text === nextPageStr) {
          nextHref = $(el).attr('href');
          return false;
        }
      });
    }

    if (!nextHref) {
      progress.stopReason = 'No next page link found in static HTML.';
      break;
    }

    if (currentPage >= limits.maxPages) {
      progress.safetyLimitReached = true;
      progress.stopReason = `Configured maximum pages limit (${limits.maxPages}) reached.`;
      break;
    }

    let resolvedNextUrl: string;
    try {
      resolvedNextUrl = new URL(nextHref, currentUrl).toString();
      if (visitedUrls.has(resolvedNextUrl)) {
        progress.stopReason = 'Next page link points to an already visited URL (cycle detected).';
        break;
      }
      visitedUrls.add(resolvedNextUrl);
      await validateHopUrl(resolvedNextUrl, initialUrl, { allowLoopback });
    } catch (err: any) {
      progress.stopReason = `Next URL failed validation: ${err.message}`;
      break;
    }

    // Fetch next page
    try {
      progress.requestsMade++;
      const res = await fetchPublicUrl(resolvedNextUrl, { allowLoopback });
      currentHtml = res.html;
      currentUrl = resolvedNextUrl;
      currentPage++;
    } catch (err: any) {
      progress.failedRecords++;
      progress.stopReason = `Failed to fetch next page: ${err.message}`;
      break;
    }
  }

  return { cards: allCards, progress };
}
