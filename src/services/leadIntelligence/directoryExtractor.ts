import * as cheerio from 'cheerio';
import { URL } from 'url';
import { ExtractedRawLead, ExtractionResult } from './extractionService';
import { classifyPage, PageClassification, isRelatedDomain, getRootDomain, EXCLUDED_DOMAINS } from './pageClassifier';
import { validatePublicUrl, validateHopUrl, fetchPublicUrl, FetchedWebContent, UrlSecurityError } from './urlFetcherService';
import { renderPageWithPlaywright, PlaywrightRenderResult } from './playwrightService';
import { normalizeCompanyName, normalizeDomain } from './normalizationService';

import {
  PaginationStrategy,
  DEFAULT_SAFETY_LIMITS,
  detectApiPaginationPattern,
  paginateApiEndpoint,
  paginateDomNext,
  paginateStaticHtml,
  ProgressCallback,
  CheckCancelledCallback,
} from './paginationEngine';

export interface DirectoryExtractOptions {
  maxRecords?: number | undefined;
  maxDetailPages?: number | undefined;
  maxRequests?: number | undefined;
  maxPages?: number | undefined;
  allowLoopback?: boolean | undefined;
  mode?: 'sample' | 'limited' | 'all' | undefined;
  onProgress?: ProgressCallback | undefined;
  checkCancelled?: CheckCancelledCallback | undefined;
}

export interface DirectoryProgressMetrics {
  strategy: PaginationStrategy;
  totalPages: number;
  pagesProcessed: number;
  recordsDiscovered: number;
  recordsProcessed: number;
  detailUrlsDiscovered: number;
  detailPagesProcessed: number;
  successfulRecords: number;
  uniqueRecords: number;
  duplicates: number;
  possibleDuplicates: number;
  failedPages: number;
  skippedUrls: number;
  requestsMade: number;
  stopReason?: string | undefined;
  safetyLimitReached?: boolean | undefined;
}

export interface DirectoryExtractionResult extends ExtractionResult {
  metrics: DirectoryProgressMetrics;
  classification: PageClassification;
}

export interface CandidateCard {
  companyName?: string | undefined;
  rawName?: string | undefined;
  detailUrl?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  category?: string | undefined;
  city?: string | undefined;
  hallOrBooth?: string | undefined;
  boothNumber?: string | undefined;
  hallNumber?: string | undefined;
  websiteUrl?: string | undefined;
  rawText: string;
}

const ORGANIZER_TITLE_PATTERNS = [
  /^exhibitor\s+directory/i,
  /^directory/i,
  /^member\s+directory/i,
  /^participants/i,
  /^attendees/i,
  /^vendor\s+catalog/i,
  /^trade\s+fair\s+directory/i,
  /^expo\s+directory/i,
  /^all\s+exhibitors/i,
  /^search\s+exhibitors/i,
  /^featured\s*\(\d+\)/i,
  /^(?:npe|pack\s*expo|imex|gitex|ces|hannover\s*messe|semashow|canton\s*fair|fabtech)\s*(?:20\d\d)?/i,
  /:\s*the\s+(?:plastics|packaging|manufacturing|baking)\s+show/i,
  /\b(?:the\s+plastics\s+show|the\s+packaging\s+show|the\s+baking\s+expo)\b/i,
  /^(?:event|conference|summit|exhibition|trade\s*show)\s*(?:20\d\d)?$/i,
];

/**
 * Checks if candidate company name is actually the directory name or generic UI label
 */
export function isDirectoryOrganizerName(name: string): boolean {
  if (!name || name.length < 2) return true;
  const lower = name.trim().toLowerCase();
  if (ORGANIZER_TITLE_PATTERNS.some(p => p.test(lower))) return true;
  if (lower === 'exhibitor directory' || lower === 'directory' || lower === 'home' || lower === 'back') return true;
  return false;
}

/**
 * Generic field mapping for dynamic public API JSON payloads (e.g., eventstrat, exhibitor API, etc.)
 */
export function mapJsonRecordToLead(item: any, sourceUrl: string, baseOriginUrl: string, organizerEmails: string[]): Partial<ExtractedRawLead> | null {
  if (!item || typeof item !== 'object') return null;

  // Extract company name generically
  let companyName = 
    item.companyName || item.company_name || item.exhibitorName || item.exhibitor_name ||
    item.business_name || item.organization;

  const hasBusinessFields = Boolean(
    item.email || item.contact_email || item.phone || item.mobile || item.telephone ||
    item.contactPerson || item.contactPersonName || item.contact_person || item.contact ||
    item.website || item.website_url || item.city || item.location || item.stallNumber ||
    item.hallNumber || item.stall || item.booth || item.urn
  );

  if (!companyName && hasBusinessFields) {
    companyName = item.name || item.company || item.title;
  }

  if (!companyName || typeof companyName !== 'string' || isDirectoryOrganizerName(companyName)) {
    return null;
  }

  // Filter out category labels (e.g. "1. APPAREL & FASHION") or floor plans
  if (/^\d+\.\s+[A-Z\s&]+$/.test(companyName.trim()) || /floor\s+layout|floor\s+plan/i.test(companyName)) {
    return null;
  }

  // Extract contact person
  const contactName = 
    item.contactPerson || item.contactPersonName || item.contact_person || item.contact_name || item.contact ||
    item.person || item.representative || item.lead_name || item.owner;

  // Extract email (suppressing organizer emails)
  let email = item.email || item.contact_email || item.mail || item.company_email;
  if (typeof email === 'string') {
    email = email.trim().toLowerCase();
    if (organizerEmails.includes(email) || email.includes('exhibition@') || email.includes('directory@')) {
      email = undefined;
    }
  } else {
    email = undefined;
  }

  // Extract phone
  const phone = item.phone || item.mobile || item.telephone || item.contact_no || item.cell;

  // Extract location / city / state / country
  const city = item.city || item.location || item.district;
  const state = item.state || item.province;
  const country = item.country || item.nation;
  let address = item.address || item.full_address;

  // Extract category / industry
  const industry = item.category || item.subcategory || item.productGroupName || item.productCategory || item.industry || item.sector || item.products;

  // Extract booth / hall / stall
  const hall = item.hall || item.hallNumber || item.hall_no;
  const stall = item.booth || item.stallNumber || item.stall || item.stand;
  if (!address && (hall || stall)) {
    address = [hall, stall].filter(Boolean).join(' / ');
  }

  // Extract website or detail URL
  let websiteUrl = item.website || item.website_url || item.url || item.web;
  let detailUrl: string | undefined;

  const urn = item.urn || item.id || item.slug || item.code;
  if (urn && baseOriginUrl) {
    try {
      const u = new URL(baseOriginUrl);
      detailUrl = `${u.origin}${u.pathname.replace(/\/$/, '')}/${urn}`;
    } catch {}
  }

  return {
    rawName: companyName.trim(),
    companyName: companyName.trim(),
    boothNumber: typeof stall === 'string' ? stall.trim() : undefined,
    hallNumber: typeof hall === 'string' ? hall.trim() : undefined,
    category: typeof industry === 'string' ? industry.trim() : undefined,
    detailUrl,
    sourceUrl,
    contactName: typeof contactName === 'string' ? contactName.trim() : undefined,
    email,
    phone: typeof phone === 'string' ? phone.trim() : undefined,
    city: typeof city === 'string' ? city.trim() : undefined,
    state: typeof state === 'string' ? state.trim() : undefined,
    country: typeof country === 'string' ? country.trim() : undefined,
    address: typeof address === 'string' ? address.trim() : undefined,
    industry: typeof industry === 'string' ? industry.trim() : undefined,
    websiteUrl: typeof websiteUrl === 'string' ? websiteUrl.trim() : undefined,
  };
}

/**
 * Extracts candidate cards and detail links from HTML using structural heuristics
 */
export function extractCardsFromHtml(
  html: string,
  baseUrl: string,
  organizerEmails: string[],
  organizerPhones: string[]
): CandidateCard[] {
  const $ = cheerio.load(html);
  // Strip navigation, header, footer, and menu elements to avoid extracting menu links as company cards
  $('nav, header, footer, [class*="menu"], [class*="nav"], [class*="sidebar"], [id*="menu"], [id*="nav"]').remove();
  const cards: CandidateCard[] = [];

  // Check if baseUrl specifies a fragment/hash targeting a section or if DOM has a dedicated exhibitor section
  let targetScope: any = $('body');
  try {
    const parsedUrl = new URL(baseUrl);
    const hash = parsedUrl.hash.replace(/^#/, '');
    if (hash && $(`#${hash}`).length > 0) {
      targetScope = $(`#${hash}`);
    }
  } catch {}

  if (targetScope.is('body')) {
    const dedicatedSection = $('section[id*="exhibitor"], div[id*="exhibitor"], section[class*="exhibitor"], [class*="exhibitor-section"]');
    if (dedicatedSection.length > 0 && dedicatedSection.find('[class*="exhibitor"]').length >= 10) {
      targetScope = dedicatedSection;
    }
  }

  // Strip non-card controls from target scope
  targetScope.find('button, [class*="btn"], [class*="tab-btn"], [class*="nav-tabs"], [class*="filter"]').remove();

  // Repeated container selectors
  const containerSelectors = [
    '[class*="exhibitor-card"]',
    '[class*="exhibitor_card"]',
    '[class*="exhibitor-item"]',
    '[class*="exhibitor_item"]',
    'article',
    '.card',
    '[class*="card"]',
    '[class*="item"]',
    '[class*="exhibitor"]',
    '[class*="listing"]',
    '[class*="tile"]',
    '[class*="directory-row"]',
    '.row > div',
    'table tbody tr',
    'ul.directory-list > li',
  ];

  let selectedElements: any = targetScope.find(containerSelectors.join(', '));
  
  // If no common class matched in target scope, search whole body
  if (selectedElements.length === 0) {
    selectedElements = $(containerSelectors.join(', '));
  }

  // If still no common class matched, look for repeated divs that have headings or contacts
  if (selectedElements.length === 0) {
    selectedElements = $('div').filter((_, el) => {
      const hasHeading = $(el).find('h1, h2, h3, h4, h5, strong').length > 0;
      const text = $(el).text().trim();
      const directTextLen = text.length;
      const hasContact = /@|phone|tel|contact/i.test(text);
      return (hasHeading || hasContact) && directTextLen > 20 && directTextLen < 1500;
    });
  }

  // Filter out wrapper containers that contain child matching cards
  const leafElements = selectedElements.filter((_: number, el: any) => {
    return $(el).find(containerSelectors.join(', ')).length === 0;
  });
  const effectiveElements = leafElements.length > 0 ? leafElements : selectedElements;

  effectiveElements.each((_: number, el: any) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length < 2) return;

    // Extract company name: prefer h1-h5 or strong or [class*="name"]
    let companyName = $(el).find('h1, h2, h3, h4, h5, [class*="name"], [class*="title"], strong').first().text().trim();
    if (!companyName) {
      // Fallback: first link text
      companyName = $(el).find('a').first().text().trim();
    }
    if (!companyName) {
      // Direct text fallback for cards where company name is direct text node (e.g. <div class="exhibitor-card-item">Company Name</div>)
      const directText = $(el).clone().children().remove().end().text().replace(/\s+/g, ' ').trim() || text;
      if (directText.length >= 2 && directText.length <= 100) {
        companyName = directText;
      }
    }

    // Clean company name
    companyName = companyName.replace(/^(exhibitor|company|name):\s*/i, '').trim();
    if (!companyName || companyName.length < 2 || isDirectoryOrganizerName(companyName)) return;

    // Filter out obvious navigation / tab boilerplate
    if (/^(explore|view all|show more|read more|click here|home|about us|contact us|past exhibitors|confirmed exhibitors)$/i.test(companyName)) return;

    // Find candidate detail link
    let detailUrl: string | undefined;
    $(el).find('a[href]').each((_, a) => {
      const href = $(a).attr('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      try {
        const resolved = new URL(href, baseUrl).toString();
        const parsed = new URL(resolved);
        const host = parsed.hostname.toLowerCase();
        // Skip social media
        if (EXCLUDED_DOMAINS.some(d => host.includes(d))) return;

        if (isRelatedDomain(resolved, baseUrl)) {
          detailUrl = resolved;
          return false; // Break
        }
      } catch {}
    });

    // Extract inline email
    let email: string | undefined;
    const mailto = $(el).find('a[href^="mailto:"]').attr('href');
    if (mailto) {
      email = mailto.replace(/^mailto:/i, '').split('?')[0]?.trim().toLowerCase();
    } else {
      const emailMatches = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g);
      if (emailMatches && emailMatches[0]) {
        email = emailMatches[0].toLowerCase().trim();
      }
    }
    if (email && organizerEmails.includes(email)) {
      email = undefined;
    }

    // Extract inline phone
    let phone: string | undefined;
    const tel = $(el).find('a[href^="tel:"]').attr('href');
    if (tel) {
      phone = tel.replace(/^tel:/i, '').trim();
    } else {
      const phoneElem = $(el).find('[class*="phone"], [class*="tel"], [class*="mobile"], [class*="contact_no"]').first().text().trim();
      if (phoneElem && phoneElem.replace(/\D/g, '').length >= 7) {
        phone = phoneElem;
      } else {
        const phoneMatches = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}(?:[-.\s]?\d{3,4})?/g);
        if (phoneMatches && phoneMatches[0] && phoneMatches[0].replace(/\D/g, '').length >= 7) {
          phone = phoneMatches[0].trim();
        }
      }
    }
    if (phone && organizerPhones.includes(phone)) {
      phone = undefined;
    }

    // Extract category / tags
    const category = $(el).find('[class*="category"], [class*="tag"], [class*="badge"], [class*="industry"]').first().text().trim() || undefined;

    // Extract city / location
    const city = $(el).find('[class*="location"], [class*="city"], [class*="address"]').first().text().trim() || undefined;

    // Extract booth / hall
    let hallOrBooth: string | undefined;
    const boothMatch = text.match(/\b(hall|booth|stall|stand)[\s#:]*([a-zA-Z0-9\s\-/]+)/i);
    if (boothMatch && boothMatch[0]) {
      hallOrBooth = boothMatch[0].trim();
    }

    cards.push({
      companyName,
      detailUrl,
      email,
      phone,
      category,
      city,
      hallOrBooth,
      rawText: text,
    });
  });

  return cards;
}

/**
 * Parses a detail page HTML to extract rich company and contact information
 */
export function parseDetailPageHtml(
  html: string,
  detailUrl: string,
  organizerEmails: string[],
  organizerPhones: string[]
): Partial<ExtractedRawLead> {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, nav, footer').remove();

  const fullText = $('body').text().replace(/\s+/g, ' ').trim();

  // Company Name
  let companyName = $('h1').first().text().trim() ||
    $('[class*="company-name"], [class*="profile-title"], [class*="exhibitor-name"]').first().text().trim() ||
    $('title').text().split(/[-|:]/)[0]?.trim() || '';

  companyName = companyName.replace(/^(exhibitor|company|profile):\s*/i, '').trim();
  if (isDirectoryOrganizerName(companyName)) {
    companyName = '';
  }

  // Contact Person / Name
  let contactName: string | undefined;
  let contactTitle: string | undefined;

  // Look for label-based patterns: "Contact Person: Puneet Ahuja"
  const contactPersonMatch = fullText.match(/(?:contact\s+person|contact\s+name|representative|contact)[\s:]+([a-zA-Z\s.]+?)(?:\s+(?:email|phone|mobile|tel|hall|category|address|designation)|$)/i);
  if (contactPersonMatch && contactPersonMatch[1]) {
    contactName = contactPersonMatch[1].trim();
  }

  if (!contactName) {
    const contactElem = $('[class*="contact-person"], [class*="contact_name"], [class*="representative"]').first().text().trim();
    if (contactElem && contactElem.length < 50) {
      contactName = contactElem;
    }
  }

  // Contact Title (e.g. Director, Partner, Manager, Head of R&D)
  const titleMatch = fullText.match(/(?:designation|title|role|position)[\s:]+([a-zA-Z0-9\s&/.-]+?)(?:\s+(?:email|phone|mobile|hall|city|address|location|website)|$)/i);
  if (titleMatch && titleMatch[1]) {
    contactTitle = titleMatch[1].trim();
  }

  if (!contactTitle) {
    $('p, div, li, tr').each((_, el) => {
      const t = $(el).text().trim();
      const m = t.match(/^(?:designation|title|role|position)[\s:]+([a-zA-Z0-9\s&/.-]+)$/i);
      if (m && m[1]) {
        contactTitle = m[1].trim();
        return false;
      }
    });
  }

  // Email extraction (strictly filter out organizer emails)
  let email: string | undefined;
  const mailtoLinks = $('a[href^="mailto:"]');
  mailtoLinks.each((_, a) => {
    const raw = $(a).attr('href')?.replace(/^mailto:/i, '').split('?')[0]?.trim().toLowerCase();
    if (raw && !organizerEmails.includes(raw) && !raw.includes('exhibition@') && !raw.includes('admin@') && !raw.includes('support@')) {
      email = raw;
      return false; // Break
    }
  });

  if (!email) {
    const emailMatches = fullText.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g) || [];
    for (const em of emailMatches) {
      const clean = em.toLowerCase().trim();
      if (!organizerEmails.includes(clean) && !clean.includes('exhibition@') && !clean.includes('directory@')) {
        email = clean;
        break;
      }
    }
  }

  // Phone extraction
  let phone: string | undefined;
  const telLinks = $('a[href^="tel:"]');
  telLinks.each((_, a) => {
    const raw = $(a).attr('href')?.replace(/^tel:/i, '').trim();
    if (raw && !organizerPhones.includes(raw)) {
      phone = raw;
      return false;
    }
  });

  if (!phone) {
    const phoneMatches = fullText.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g) || [];
    for (const ph of phoneMatches) {
      const clean = ph.trim();
      if (clean.length >= 8 && !organizerPhones.includes(clean)) {
        phone = clean;
        break;
      }
    }
  }

  // Category / Industry
  let industry: string | undefined;
  const catMatch = fullText.match(/(?:category|industry|sector)[\s:]+([a-zA-Z\s&/]+?)(?:\s+(?:subcategory|hall|location|contact|address)|$)/i);
  if (catMatch && catMatch[1]) {
    industry = catMatch[1].trim();
  }

  // Location / City / State / Country
  let city: string | undefined;
  let state: string | undefined;
  let country: string | undefined;
  let address: string | undefined;

  const locMatch = fullText.match(/(?:location|city)[\s:]+([a-zA-Z\s,]+?)(?:\s+(?:state|country|hall|contact|email)|$)/i);
  if (locMatch && locMatch[1]) {
    city = locMatch[1].trim();
  }

  // Outbound Website URL (company's external website)
  let websiteUrl: string | undefined;
  let domain: string | undefined;
  const detailHost = new URL(detailUrl).hostname;
  const detailRoot = getRootDomain(detailHost);
  
  const EVENT_EXCLUSIONS = [
    'mapyourshow.com', 'xpressreg.net', 'eventbrite.com', 'expofp.com',
    'a2zinc.net', 'google.com', 'apple.com', 'microsoft.com',
    'npe.org', 'packexpointernational.com', 'plasticsindustry.org', 'pmmi.org'
  ];

  // Pass 1: Explicit website buttons or anchor texts that look like domains/URLs
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    try {
      const resolved = new URL(href, detailUrl);
      const host = resolved.hostname.toLowerCase();
      if (
        host !== detailHost &&
        !host.endsWith(`.${detailRoot}`) &&
        !EXCLUDED_DOMAINS.some((d) => host.includes(d)) &&
        !EVENT_EXCLUSIONS.some((d) => host.includes(d)) &&
        !resolved.pathname.includes('privacy') &&
        !resolved.pathname.includes('terms') &&
        !resolved.pathname.includes('register')
      ) {
        const text = $(a).text().trim().toLowerCase();
        const cls = ($(a).attr('class') || '').toLowerCase();
        const isExplicit =
          text.includes('www.') ||
          text.includes('.com') ||
          text.includes('.net') ||
          text.includes('.org') ||
          text.includes('.io') ||
          text.includes('.co') ||
          text.includes('http') ||
          /^(?:visit\s+website|company\s+website|official\s+website|website|homepage|view\s+site)$/i.test(text) ||
          cls.includes('website') ||
          cls.includes('web-link') ||
          cls.includes('company-link');

        if (isExplicit) {
          websiteUrl = resolved.toString();
          domain = normalizeDomain(websiteUrl) || undefined;
          return false; // Break
        }
      }
    } catch {}
  });

  // Pass 2: Fallback to first non-event outbound link
  if (!websiteUrl) {
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      try {
        const resolved = new URL(href, detailUrl);
        const host = resolved.hostname.toLowerCase();
        if (
          host !== detailHost &&
          !host.endsWith(`.${detailRoot}`) &&
          !EXCLUDED_DOMAINS.some((d) => host.includes(d)) &&
          !EVENT_EXCLUSIONS.some((d) => host.includes(d)) &&
          !host.includes('expo') &&
          !resolved.pathname.includes('privacy') &&
          !resolved.pathname.includes('terms') &&
          !resolved.pathname.includes('register')
        ) {
          websiteUrl = resolved.toString();
          domain = normalizeDomain(websiteUrl) || undefined;
          return false; // Break
        }
      } catch {}
    });
  }

  // Hall / Booth
  let boothNumber: string | undefined;
  let hallNumber: string | undefined;
  const STOPWORDS = new Set(['the', 'at', 'in', 'on', 'near', 'is', 'and', 'to', 'our', 'a', 'an', 'of', 'for', 'all', 'new']);
  const boothMatch = fullText.match(/\b(?:booth|stall|stand)[\s#:]*([a-zA-Z0-9\-/]+)/i);
  if (boothMatch && boothMatch[1] && !STOPWORDS.has(boothMatch[1].toLowerCase().trim())) {
    boothNumber = boothMatch[1].trim();
  }
  const hallMatch = fullText.match(/\b(?:hall)[\s#:]*([a-zA-Z0-9\-/]+)/i);
  if (hallMatch && hallMatch[1] && !STOPWORDS.has(hallMatch[1].toLowerCase().trim())) {
    hallNumber = hallMatch[1].trim();
  }
  if (!address && (hallNumber || boothNumber)) {
    address = [hallNumber ? `Hall ${hallNumber}` : null, boothNumber ? `Booth ${boothNumber}` : null].filter(Boolean).join(' / ');
  }

  return {
    rawName: companyName || undefined,
    companyName: companyName || undefined,
    boothNumber,
    hallNumber,
    category: industry,
    detailUrl,
    contactName,
    contactTitle,
    email,
    phone,
    industry,
    city,
    state,
    country,
    address,
    websiteUrl,
    domain,
  };
}

/**
 * Generic Directory Extractor
 * Automatically handles:
 * 1. Directory classification & organizer suppression
 * 2. Public data endpoint detection (intercepted JSON arrays)
 * 3. Listing card extraction (complete inline information)
 * 4. Detail-page link clustering & Playwright/Cheerio detail-page extraction
 * 5. Configurable limits & SSRF hop validation on all requests
 * 6. Progress metrics tracking
 */
export async function extractFromDirectory(
  url: string,
  options: DirectoryExtractOptions = {},
  sourceName = 'Directory Research'
): Promise<DirectoryExtractionResult> {
  const allowLoopback = options.allowLoopback || process.env.ALLOW_LOOPBACK_FOR_TESTING === 'true';
  const maxRecords = options.maxRecords ?? 5000;
  const maxRequests = options.maxRequests ?? 1000;

  // Determine detail page limit based on mode or explicit option
  let maxDetailPages = options.maxDetailPages;
  if (options.mode === 'sample') {
    maxDetailPages = maxDetailPages ?? 10;
  } else if (options.mode === 'limited') {
    maxDetailPages = maxDetailPages ?? 50;
  } else if (options.mode === 'all') {
    maxDetailPages = maxDetailPages ?? 5000;
  } else {
    maxDetailPages = maxDetailPages ?? 50;
  }

  const limits = {
    maxRecords: options.maxRecords ?? DEFAULT_SAFETY_LIMITS.maxRecords,
    maxPages: options.maxPages ?? DEFAULT_SAFETY_LIMITS.maxPages,
    maxDetailPages: options.maxDetailPages ?? DEFAULT_SAFETY_LIMITS.maxDetailPages,
    maxRequests: options.maxRequests ?? DEFAULT_SAFETY_LIMITS.maxRequests,
  };

  const metrics: DirectoryProgressMetrics = {
    strategy: 'NONE',
    totalPages: 1,
    pagesProcessed: 0,
    recordsDiscovered: 0,
    recordsProcessed: 0,
    detailUrlsDiscovered: 0,
    detailPagesProcessed: 0,
    successfulRecords: 0,
    uniqueRecords: 0,
    duplicates: 0,
    possibleDuplicates: 0,
    failedPages: 0,
    skippedUrls: 0,
    requestsMade: 0,
  };

  // 1. Initial URL validation
  await validatePublicUrl(url, { allowLoopback });
  metrics.requestsMade++;

  // 2. Fetch initial static HTML
  let initialHtml = '';
  let finalUrl = url;
  try {
    const webData = await fetchPublicUrl(url, { allowLoopback });
    initialHtml = webData.html;
    finalUrl = webData.finalUrl;
  } catch (err: any) {
    metrics.failedPages++;
    throw err;
  }

  // 3. Classify page
  const classification = classifyPage(initialHtml, finalUrl);
  const organizerEmails = [...classification.organizerEmails];
  const organizerPhones = [...classification.organizerPhones];

  let rawHtmlForCards = initialHtml;
  let dynamicFrames: Array<{ url: string; html: string }> = [];
  let capturedJsonPayloads: any[] = [];
  let domPaginatedCards: CandidateCard[] = [];

  // 4. Dynamic Playwright rendering if dynamic frames, iframes, or JS SPA detected
  const targetUrlToRender = classification.detectedIframeUrl || url;
  const initialCardsCount = extractCardsFromHtml(initialHtml, finalUrl, organizerEmails, organizerPhones).length;
  const needsDynamic = 
    Boolean(classification.detectedIframeUrl) ||
    initialHtml.includes('iframeForm') ||
    initialHtml.includes('iframeUrl=') ||
    initialHtml.includes('<iframe') ||
    initialHtml.includes('<div id="__next">') ||
    initialHtml.includes('<div id="root">') ||
    initialHtml.includes('Vue.component') ||
    initialHtml.includes('mapyourshow') ||
    (initialCardsCount < 5 && initialHtml.includes('<script')) ||
    initialHtml.length < 2000;

  if (needsDynamic) {
    try {
      const renderResult = await renderPageWithPlaywright(targetUrlToRender, {
        allowLoopback,
        maxRequests: Math.min(200, limits.maxRequests - metrics.requestsMade),
        withPage: async (page, payloads) => {
          // If no background API detected in initial render, try DOM pagination fallback
          const apiPattern = detectApiPaginationPattern(payloads);
          if (!apiPattern) {
            const domRes = await paginateDomNext(
              page,
              targetUrlToRender,
              organizerEmails,
              organizerPhones,
              limits,
              options.onProgress,
              options.checkCancelled
            );
            domPaginatedCards = domRes.cards;
            metrics.strategy = domRes.progress.strategy;
            metrics.pagesProcessed = Math.max(metrics.pagesProcessed, domRes.progress.pagesProcessed);
            metrics.requestsMade += domRes.progress.requestsMade;
            metrics.stopReason = domRes.progress.stopReason;
            metrics.safetyLimitReached = domRes.progress.safetyLimitReached;
          }
        },
      });

      metrics.requestsMade += renderResult.requestsMade;
      rawHtmlForCards = renderResult.html;
      dynamicFrames = renderResult.frameHtmls;
      capturedJsonPayloads = renderResult.capturedJsonPayloads;
    } catch (err: any) {
      console.warn('Playwright rendering fallback encountered error, proceeding with static HTML:', err.message);
    }
  }

  const discoveredLeads: ExtractedRawLead[] = [];
  const rawRecords: Array<{ rowNumber?: number; rawText?: string; rawData?: any; parseStatus: 'PARSED' | 'FAILED'; errorMessage?: string }> = [];
  const seenCompanies = new Set<string>();

  // Helper to add lead with deduplication and metrics tracking
  const registerLead = (leadData: Partial<ExtractedRawLead>, rawText: string, provenanceUrl: string) => {
    if (!leadData.companyName || isDirectoryOrganizerName(leadData.companyName)) return;

    metrics.recordsDiscovered++;

    const normName = normalizeCompanyName(leadData.companyName);
    const normDomain = normalizeDomain(leadData.domain || leadData.websiteUrl || undefined);
    const dedupeKey = normDomain || normName;

    if (seenCompanies.has(dedupeKey)) {
      metrics.duplicates++;
      return;
    }
    seenCompanies.add(dedupeKey);
    metrics.uniqueRecords++;

    const extractedFields: string[] = ['companyName'];
    if (leadData.contactName) extractedFields.push('contactName');
    if (leadData.contactTitle) extractedFields.push('contactTitle');
    if (leadData.email) extractedFields.push('email');
    if (leadData.phone) extractedFields.push('phone');
    if (leadData.city) extractedFields.push('city');
    if (leadData.state) extractedFields.push('state');
    if (leadData.country) extractedFields.push('country');
    if (leadData.industry) extractedFields.push('industry');
    if (leadData.websiteUrl) extractedFields.push('websiteUrl');
    if (leadData.address) extractedFields.push('address');

    const rowNum = discoveredLeads.length + 1;
    const lead: ExtractedRawLead = {
      rowNumber: rowNum,
      rawText: rawText.slice(0, 3000),
      rawData: {
        ...leadData,
        provenanceUrl,
      },
      companyName: leadData.companyName,
      contactName: leadData.contactName || null,
      contactTitle: leadData.contactTitle || null,
      email: leadData.email || null,
      phone: leadData.phone || null,
      websiteUrl: leadData.websiteUrl || null,
      domain: normDomain || null,
      industry: leadData.industry || null,
      companySize: leadData.companySize || null,
      city: leadData.city || null,
      state: leadData.state || null,
      country: leadData.country || null,
      address: leadData.address || null,
      provenance: {
        sourceType: 'WEBSITE',
        sourceName,
        rowNumber: rowNum,
        url: provenanceUrl,
        extractedFields,
      },
    };

    discoveredLeads.push(lead);
    rawRecords.push({
      rowNumber: rowNum,
      rawText: rawText.slice(0, 3000),
      rawData: lead.rawData,
      parseStatus: 'PARSED',
    });

    metrics.successfulRecords++;
    metrics.recordsProcessed++;
  };

  // 5. Check Detected Public API Pagination Pattern (Fast generic JSON endpoint pagination)
  const apiPattern = detectApiPaginationPattern(capturedJsonPayloads);
  if (apiPattern) {
    metrics.strategy = apiPattern.isOffsetBased ? 'OFFSET' : 'API_QUERY';
    metrics.totalPages = apiPattern.totalPages;

    const apiRes = await paginateApiEndpoint(
      apiPattern,
      targetUrlToRender,
      organizerEmails,
      limits,
      options.onProgress,
      options.checkCancelled,
      allowLoopback
    );

    metrics.pagesProcessed = Math.max(metrics.pagesProcessed, apiRes.progress.pagesProcessed);
    metrics.requestsMade += apiRes.progress.requestsMade;
    metrics.stopReason = apiRes.progress.stopReason;
    metrics.safetyLimitReached = apiRes.progress.safetyLimitReached;

    for (const leadData of apiRes.leads) {
      if (discoveredLeads.length >= limits.maxRecords) break;
      registerLead(leadData, JSON.stringify(leadData), apiPattern.baseUrl);
    }
  } else if (capturedJsonPayloads.length > 0) {
    // Single page JSON payload
    for (const payload of capturedJsonPayloads) {
      if (Array.isArray(payload.data)) {
        for (const item of payload.data) {
          if (discoveredLeads.length >= limits.maxRecords) break;
          const mapped = mapJsonRecordToLead(item, payload.url, url, organizerEmails);
          if (mapped && mapped.companyName) {
            registerLead(mapped, JSON.stringify(item), payload.url);
          }
        }
      }
    }
  }

  // 6. If not enough leads from background API, collect candidate cards from DOM / Static HTML
  if (discoveredLeads.length < 5) {
    const collectedCards: CandidateCard[] = [];

    if (domPaginatedCards.length > 0) {
      collectedCards.push(...domPaginatedCards);
    } else {
      // Check static HTML pagination
      const staticRes = await paginateStaticHtml(
        rawHtmlForCards,
        finalUrl,
        organizerEmails,
        organizerPhones,
        limits,
        options.onProgress,
        options.checkCancelled,
        allowLoopback
      );

      if (staticRes.cards.length > 0) {
        metrics.strategy = staticRes.progress.strategy;
        metrics.pagesProcessed = Math.max(metrics.pagesProcessed, staticRes.progress.pagesProcessed);
        metrics.requestsMade += staticRes.progress.requestsMade;
        metrics.stopReason = staticRes.progress.stopReason;
        metrics.safetyLimitReached = staticRes.progress.safetyLimitReached;
        collectedCards.push(...staticRes.cards);
      } else {
        const htmlSources = [rawHtmlForCards, ...dynamicFrames.map(f => f.html)];
        for (const htmlSrc of htmlSources) {
          collectedCards.push(...extractCardsFromHtml(htmlSrc, finalUrl, organizerEmails, organizerPhones));
        }
      }
    }

    const detailUrlsToVisit: Array<{ card: CandidateCard; detailUrl: string }> = [];

    for (const card of collectedCards) {
      if (!card.companyName || isDirectoryOrganizerName(card.companyName)) continue;

      if (card.detailUrl) {
        metrics.detailUrlsDiscovered++;
        detailUrlsToVisit.push({ card, detailUrl: card.detailUrl });
      } else {
        registerLead({
          rawName: card.companyName,
          companyName: card.companyName,
          boothNumber: card.boothNumber,
          hallNumber: card.hallNumber,
          category: card.category,
          sourceUrl: finalUrl,
          email: card.email,
          phone: card.phone,
          industry: card.category,
          city: card.city,
          address: card.hallOrBooth,
          websiteUrl: card.websiteUrl,
        }, card.rawText, finalUrl);
      }
    }

    // Process detail pages up to maxDetailPages
    const processBatch = detailUrlsToVisit.slice(0, limits.maxDetailPages);

    for (const item of processBatch) {
      if (discoveredLeads.length >= limits.maxRecords || metrics.requestsMade >= limits.maxRequests) break;

      let validatedDetailUrl: string;
      try {
        validatedDetailUrl = await validateHopUrl(item.detailUrl, finalUrl, { allowLoopback });
      } catch (err: any) {
        metrics.skippedUrls++;
        continue;
      }

      metrics.detailPagesProcessed++;
      metrics.requestsMade++;

      let detailLeadData: Partial<ExtractedRawLead> = {};
      let detailRawText = item.card.rawText;

      try {
        const detailWeb = await fetchPublicUrl(validatedDetailUrl, { allowLoopback });
        detailRawText = detailWeb.textContent;

        const detailHtml = detailWeb.html;
        if (detailHtml.includes('id="__next"') || detailHtml.includes('id="root"') || detailWeb.textContent.length < 200) {
          const renderedDetail = await renderPageWithPlaywright(validatedDetailUrl, {
            allowLoopback,
            maxRequests: 100,
            timeoutMs: 15000,
          });
          metrics.requestsMade += renderedDetail.requestsMade;
          detailLeadData = parseDetailPageHtml(renderedDetail.html, validatedDetailUrl, organizerEmails, organizerPhones);
        } else {
          detailLeadData = parseDetailPageHtml(detailHtml, validatedDetailUrl, organizerEmails, organizerPhones);
        }
      } catch (err: any) {
        metrics.failedPages++;
        console.warn(`Failed to process detail page ${validatedDetailUrl}:`, err.message);
      }

      const mergedLead: Partial<ExtractedRawLead> = {
        rawName: detailLeadData.rawName || item.card.companyName,
        companyName: detailLeadData.companyName || item.card.companyName,
        boothNumber: detailLeadData.boothNumber || item.card.boothNumber,
        hallNumber: detailLeadData.hallNumber || item.card.hallNumber,
        category: detailLeadData.category || item.card.category,
        detailUrl: validatedDetailUrl,
        sourceUrl: finalUrl,
        contactName: detailLeadData.contactName,
        contactTitle: detailLeadData.contactTitle,
        email: detailLeadData.email || item.card.email,
        phone: detailLeadData.phone || item.card.phone,
        industry: detailLeadData.industry || item.card.category,
        city: detailLeadData.city || item.card.city,
        state: detailLeadData.state,
        country: detailLeadData.country,
        address: detailLeadData.address || item.card.hallOrBooth,
        websiteUrl: detailLeadData.websiteUrl || item.card.websiteUrl,
        domain: detailLeadData.domain,
      };

      registerLead(mergedLead, detailRawText, validatedDetailUrl);
    }
  }

  if (metrics.pagesProcessed === 0) metrics.pagesProcessed = 1;
  const status = discoveredLeads.length > 0 ? (metrics.failedPages > 0 || metrics.safetyLimitReached ? 'PARTIAL' : 'COMPLETED') : 'FAILED';

  return {
    status,
    leads: discoveredLeads,
    rawRecords,
    totalRecords: discoveredLeads.length,
    metrics,
    classification,
    errorMessage: status === 'FAILED' ? 'No directory records could be extracted from this page.' : undefined,
  };
}
