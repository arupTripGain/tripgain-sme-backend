import * as cheerio from 'cheerio';
import { URL } from 'url';

export type PageType = 'DIRECTORY' | 'DETAIL' | 'SINGLE_COMPANY';

export interface PageClassification {
  pageType: PageType;
  confidence: number;
  reasons: string[];
  detectedIframeUrl?: string | undefined;
  organizerEmails: string[];
  organizerPhones: string[];
}

/**
 * Common directory indicator keywords in URL path, title, or body
 */
const DIRECTORY_KEYWORDS = [
  'directory', 'exhibitor', 'exhibitors', 'catalog', 'catalogue', 
  'members', 'member-directory', 'participants', 'attendees', 
  'vendors', 'companies', 'fair-directory', 'expo', 'delegates'
];

/**
 * Common social media and non-detail domains to ignore
 */
export const EXCLUDED_DOMAINS = [
  'facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'instagram.com',
  'youtube.com', 'google.com', 'doubleclick.net', 'googletagmanager.com',
  'apple.com', 'whatsapp.com', 't.me', 'pinterest.com', 'tiktok.com'
];

/**
 * Extracts the registered root domain (e.g., "exhibitor.bharat-tex.com" -> "bharat-tex.com")
 */
export function getRootDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return hostname.toLowerCase();
  
  // Handle two-part TLDs like co.uk, com.au, co.in
  const twoPartTlds = ['co.uk', 'com.au', 'co.in', 'org.uk', 'gov.in', 'ac.in', 'edu.au'];
  const lastTwo = parts.slice(-2).join('.');
  if (twoPartTlds.includes(lastTwo) && parts.length >= 3) {
    const root = parts.slice(-3).join('.');
    return root;
  }

  const root = parts.slice(-2).join('.');
  return root;
}

/**
 * Checks if candidate URL belongs to the same registered root domain as the initial URL
 */
export function isRelatedDomain(candidateUrlStr: string, initialUrlStr: string): boolean {
  try {
    const candidate = new URL(candidateUrlStr);
    const initial = new URL(initialUrlStr);
    
    if (candidate.hostname === initial.hostname) return true;
    
    const root1 = getRootDomain(candidate.hostname);
    const root2 = getRootDomain(initial.hostname);
    return root1 === root2;
  } catch {
    return false;
  }
}

/**
 * Analyzes HTML content and URL to classify page as DIRECTORY, DETAIL, or SINGLE_COMPANY
 */
export function classifyPage(html: string, url: string): PageClassification {
  const $ = cheerio.load(html);
  const parsedUrl = new URL(url);
  const pathname = parsedUrl.pathname.toLowerCase();
  const title = $('title').text().toLowerCase();

  const reasons: string[] = [];
  let directoryScore = 0;

  // 1. Detect iframes or iframe loader scripts
  let detectedIframeUrl: string | undefined;
  
  $('iframe').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src && !src.includes('google') && !src.includes('youtube') && !src.includes('vimeo')) {
      try {
        const abs = new URL(src, url).toString();
        detectedIframeUrl = abs;
        reasons.push(`Detected directory iframe src: ${abs}`);
        directoryScore += 40;
      } catch {}
    }
  });

  // Check script tags that load iframes via parameters (e.g. ?iframeUrl=...)
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (src.includes('iframeUrl=')) {
      try {
        const scriptUrl = new URL(src, url);
        const embedded = scriptUrl.searchParams.get('iframeUrl');
        if (embedded) {
          detectedIframeUrl = embedded;
          reasons.push(`Detected dynamic iframe loader in script: ${embedded}`);
          directoryScore += 50;
        }
      } catch {}
    }
  });

  // 2. Keyword signals in URL path, hash, or title
  const hasDirKeywordInUrl = DIRECTORY_KEYWORDS.some(k => pathname.includes(k));
  if (hasDirKeywordInUrl) {
    directoryScore += 30;
    reasons.push('URL path contains directory keywords');
  }

  const hash = parsedUrl.hash.toLowerCase();
  const hasDirKeywordInHash = DIRECTORY_KEYWORDS.some(k => hash.includes(k));
  if (hasDirKeywordInHash) {
    directoryScore += 35;
    reasons.push(`URL fragment/hash (${parsedUrl.hash}) contains directory keywords`);
  }

  const hasDirKeywordInTitle = DIRECTORY_KEYWORDS.some(k => title.includes(k));
  if (hasDirKeywordInTitle) {
    directoryScore += 20;
    reasons.push('Title contains directory keywords');
  }

  // 2b. Check dedicated DOM sections for exhibitor directory patterns
  const exhibitorSections = $('[id*="exhibitor"], [class*="exhibitor-section"], [class*="exhibitor-list"], [id*="directory"]');
  if (exhibitorSections.length > 0) {
    directoryScore += 25;
    reasons.push('DOM contains dedicated exhibitor/directory sections');
  }

  // 3. Repeated container cards, rows, or list elements
  const specificExhibitorCards = $('[class*="exhibitor-card"], [class*="exhibitor-item"], [class*="exhibitor_card"], [class*="exhibitor_item"]');
  if (specificExhibitorCards.length >= 10) {
    directoryScore += 40;
    reasons.push(`Detected ${specificExhibitorCards.length} dedicated exhibitor card elements`);
  }

  const cards = $('.card, article, [class*="card"], [class*="item"], [class*="exhibitor"], tr, li');
  if (cards.length >= 5) {
    directoryScore += 25;
    reasons.push(`Found ${cards.length} repeated candidate card/list elements`);
  }

  // 4. Repeated detail link structure analysis
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      try {
        const resolved = new URL(href, url).toString();
        if (isRelatedDomain(resolved, url)) {
          links.push(resolved);
        }
      } catch {}
    }
  });

  // Group paths by pattern (e.g. /prefix/:id)
  const pathPrefixCounts: Record<string, number> = {};
  links.forEach(l => {
    try {
      const u = new URL(l);
      const segments = u.pathname.split('/').filter(Boolean);
      if (segments.length >= 2) {
        const prefix = '/' + segments.slice(0, -1).join('/');
        pathPrefixCounts[prefix] = (pathPrefixCounts[prefix] || 0) + 1;
      }
    } catch {}
  });

  const topPrefixPattern = Object.entries(pathPrefixCounts).find(([_, count]) => count >= 4);
  if (topPrefixPattern) {
    directoryScore += 35;
    reasons.push(`Detected repeated link pattern "${topPrefixPattern[0]}/*" (${topPrefixPattern[1]} links)`);
  }

  // 5. Extract top-level organizer contacts from header / footer
  const organizerEmails: string[] = [];
  const organizerPhones: string[] = [];

  // Footer / Header contact info
  $('footer, header, .footer, .contact-organizer, #footer').each((_, container) => {
    const text = $(container).text();
    const emails = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g) || [];
    emails.forEach(e => {
      const clean = e.toLowerCase().trim();
      if (!organizerEmails.includes(clean)) organizerEmails.push(clean);
    });

    const phones = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g) || [];
    phones.forEach(p => {
      const clean = p.trim();
      if (clean.length >= 8 && !organizerPhones.includes(clean)) organizerPhones.push(clean);
    });
  });

  // If page title specifically matches directory organizer e.g. "Exhibitor Directory"
  if (directoryScore >= 40) {
    // Collect all emails directly appearing in the directory wrapper/organizer sections
    const pageEmails = html.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g) || [];
    const rootDom = getRootDomain(parsedUrl.hostname);
    pageEmails.forEach(e => {
      const lower = e.toLowerCase();
      const isOrganizerDomain = lower.endsWith(`@${rootDom}`) || lower.endsWith(`.${rootDom}`);
      const isOrganizerRole = /^(exhibition|organizer|support|admin|contact|help|info|secretariat|events|expo|fair)@/i.test(lower);
      if (isOrganizerDomain && isOrganizerRole) {
        if (!organizerEmails.includes(lower)) organizerEmails.push(lower);
      } else if (isOrganizerRole && (lower.includes('directory') || lower.includes('exhibition') || lower.includes('fair'))) {
        if (!organizerEmails.includes(lower)) organizerEmails.push(lower);
      }
    });

    return {
      pageType: 'DIRECTORY',
      confidence: Math.min(1.0, directoryScore / 100),
      reasons,
      detectedIframeUrl,
      organizerEmails,
      organizerPhones,
    };
  }

  // Check if detail page
  const hasBackToDirectory = $('a').text().toLowerCase().includes('back to directory') || 
                            $('a').text().toLowerCase().includes('all exhibitors');
  if (hasBackToDirectory && (pathname.split('/').filter(Boolean).length >= 2)) {
    return {
      pageType: 'DETAIL',
      confidence: 0.85,
      reasons: ['Contains back-to-directory link and nested path'],
      organizerEmails,
      organizerPhones,
    };
  }

  return {
    pageType: 'SINGLE_COMPANY',
    confidence: 0.7,
    reasons: ['No directory patterns or cards detected'],
    organizerEmails,
    organizerPhones,
  };
}
