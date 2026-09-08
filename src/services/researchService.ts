/**
 * ResearchService
 * 
 * Safely gathers publicly available information about a company/lead from their public website.
 * Follows strict privacy guidelines: only public website signals, no private mailboxes or personal info.
 */

export interface ResearchTarget {
  companyName?: string | null;
  website?: string | null;
  industry?: string | null;
  jobTitle?: string | null;
  fullName?: string | null;
}

export interface ResearchResult {
  hasFactualSignal: boolean;
  extractedSignals: string[];
  websiteSummary?: string | undefined;
  sourceUrl?: string | undefined;
  headings?: string[] | undefined;
}

export class ResearchService {
  /**
   * Researches a target prospect & company using public website signals.
   */
  static async researchTarget(target: ResearchTarget): Promise<ResearchResult> {
    const signals: string[] = [];
    let websiteSummary: string | undefined;
    let sourceUrl: string | undefined;
    const headings: string[] = [];

    // 1. If industry or company name is provided, record baseline facts
    if (target.industry) {
      signals.push(`Industry: ${target.industry}`);
    }
    if (target.jobTitle) {
      signals.push(`Role: ${target.jobTitle}`);
    }

    // 2. If website or domain is provided, attempt safe public fetch
    let rawUrl = (target.website || '').trim();
    if (rawUrl) {
      if (!/^https?:\/\//i.test(rawUrl)) {
        rawUrl = `https://${rawUrl}`;
      }

      try {
        const parsed = new URL(rawUrl);
        // Avoid internal IP or localhost requests
        if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname.startsWith('192.168.')) {
          return { hasFactualSignal: signals.length > 0, extractedSignals: signals };
        }

        sourceUrl = parsed.origin;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4500);

        const response = await fetch(parsed.origin, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5'
          }
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const rawHtml = await response.text();
          // Limit length to avoid high memory usage
          const htmlSnippet = rawHtml.slice(0, 50000);

          // Extract meta description
          const descMatch = htmlSnippet.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i) ||
                            htmlSnippet.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
                            htmlSnippet.match(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i);
          if (descMatch && descMatch[1]) {
            const cleanDesc = descMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
            if (cleanDesc.length > 10 && cleanDesc.length < 350) {
              websiteSummary = cleanDesc;
              signals.push(`Company Mission/Offering: ${cleanDesc}`);
            }
          }

          // Extract Title tag
          const titleMatch = htmlSnippet.match(/<title>([^<]+)<\/title>/i);
          if (titleMatch && titleMatch[1]) {
            const cleanTitle = titleMatch[1].replace(/&amp;/g, '&').trim();
            if (cleanTitle && !cleanTitle.toLowerCase().includes('just a moment') && !cleanTitle.toLowerCase().includes('403')) {
              signals.push(`Website Title: ${cleanTitle}`);
            }
          }

          // Extract <h1> and <h2> headings
          const hMatches = htmlSnippet.matchAll(/<h[12][^>]*>([^<]+)<\/h[12]>/gi);
          let count = 0;
          for (const match of hMatches) {
            if (count >= 3) break;
            const rawH = match[1];
            if (!rawH) continue;
            const hText = rawH.replace(/\s+/g, ' ').trim();
            if (hText.length > 5 && hText.length < 100) {
              headings.push(hText);
              count++;
            }
          }
          if (headings.length > 0) {
            signals.push(`Key Solutions/Headings: ${headings.join('; ')}`);
          }
        }
      } catch (fetchErr: any) {
        // Safe degrade: website unreachable, slow, or blocked bot
        // Log quietly without crashing
      }
    }

    const hasFactualSignal = signals.length > 0;

    return {
      hasFactualSignal,
      extractedSignals: signals,
      websiteSummary,
      sourceUrl,
      headings: headings.length > 0 ? headings : undefined
    };
  }
}
