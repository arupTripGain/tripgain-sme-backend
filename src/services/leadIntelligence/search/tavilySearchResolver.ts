import { normalizeDomain } from '../normalizationService';
import { ResolutionCandidate } from '../companyResolutionService';

// Comprehensive blacklist of event organizers, directory/ticketing portals, social networks, and B2B marketplaces
export const REJECTED_SEARCH_DOMAINS = new Set([
  // Social networks & media platforms
  'facebook.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'instagram.com',
  'youtube.com',
  'pinterest.com',
  'tiktok.com',
  'reddit.com',
  'medium.com',
  'github.com',

  // Search engines & generic wikis
  'wikipedia.org',
  'google.com',
  'bing.com',
  'yahoo.com',
  'duckduckgo.com',

  // Event organizers, exhibition platforms & registration
  'mapyourshow.com',
  'a2zinc.net',
  'mya2zevents.com',
  'smallworldlabs.com',
  'eventbrite.com',
  'xpressreg.net',
  'npe.org',
  'packexpointernational.com',
  'fabtechexpo.com',
  'fabtech.com',
  'agritechindia.com',

  // B2B aggregators, directories, financial filings & marketplaces
  'indiamart.com',
  'tradeindia.com',
  'exportersindia.com',
  'justdial.com',
  'zaubacorp.com',
  'tofler.in',
  'instafinancials.com',
  'alibaba.com',
  'aliexpress.com',
  'amazon.com',
  'flipkart.com',
  'yellowpages.com',
  'yelp.com',
  'crunchbase.com',
  'zoominfo.com',
  'apollo.io',
  'bloomberg.com',
  'reuters.com',
]);

/**
 * Checks whether a domain is a third-party directory, social network, or event organizer
 */
export function isRejectedSearchDomain(domain: string | null | undefined): boolean {
  if (!domain) return true;
  const clean = domain.toLowerCase().trim();
  for (const rejected of REJECTED_SEARCH_DOMAINS) {
    if (clean === rejected || clean.endsWith('.' + rejected)) {
      return true;
    }
  }
  return false;
}

export interface TavilySearchResult {
  title: string;
  url: string;
  content?: string;
  score?: number;
}

export interface TavilySearchResponse {
  query?: string;
  results?: TavilySearchResult[];
}

export interface TavilyResolverOptions {
  apiKey?: string;
  fetchFn?: typeof fetch;
  minIntervalMs?: number;
  maxRetries?: number;
}

export class TavilySearchResolver {
  private apiKey: string | null = null;
  private fetchFn: typeof fetch;
  private minIntervalMs: number;
  private maxRetries: number;
  private lastRequestTime = 0;
  private searchCache = new Map<string, ResolutionCandidate[]>();
  private loggedMissingKeyWarning = false;

  constructor(options?: TavilyResolverOptions) {
    this.apiKey = options?.apiKey ?? process.env.TAVILY_API_KEY ?? null;
    this.fetchFn = options?.fetchFn ?? (globalThis.fetch as typeof fetch);
    this.minIntervalMs = options?.minIntervalMs ?? 150;
    this.maxRetries = options?.maxRetries ?? 2;
  }

  public clearCache(): void {
    this.searchCache.clear();
  }

  public getCacheSize(): number {
    return this.searchCache.size;
  }

  /**
   * Resolves company candidates using Tavily Search API.
   * Conforms to the `(query: string) => Promise<ResolutionCandidate[]>` contract.
   */
  public async resolve(query: string): Promise<ResolutionCandidate[]> {
    const rawKey = this.apiKey ?? process.env.TAVILY_API_KEY ?? null;
    if (!rawKey || !rawKey.trim()) {
      if (!this.loggedMissingKeyWarning) {
        console.warn(
          '[TavilySearchResolver] TAVILY_API_KEY is not configured in environment. Tier 3 web search resolution is unavailable; falling back to UNRESOLVED.'
        );
        this.loggedMissingKeyWarning = true;
      }
      return [];
    }

    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];

    // Bounded query formulation: append "official website" if not already present
    const searchQuery = trimmedQuery.toLowerCase().includes('official')
      ? trimmedQuery
      : `"${trimmedQuery}" official website`;

    const cacheKey = searchQuery.toLowerCase();
    if (this.searchCache.has(cacheKey)) {
      return this.searchCache.get(cacheKey)!;
    }

    // Enforce rate limiting pacing
    const now = Date.now();
    const waitTime = this.minIntervalMs - (now - this.lastRequestTime);
    if (waitTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
    this.lastRequestTime = Date.now();

    let attempts = 0;
    let candidates: ResolutionCandidate[] = [];

    while (attempts <= this.maxRetries) {
      attempts++;
      try {
        const response = await this.fetchFn('https://api.tavily.com/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            api_key: rawKey.trim(),
            query: searchQuery,
            search_depth: 'basic',
            include_answer: false,
            include_raw_content: false,
            max_results: 5,
          }),
        });

        if (response.status === 429) {
          if (attempts <= this.maxRetries) {
            const backoffMs = attempts * 1000;
            console.warn(
              `[TavilySearchResolver] Received 429 Rate Limit. Backing off for ${backoffMs}ms (attempt ${attempts}/${this.maxRetries})...`
            );
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          } else {
            console.error('[TavilySearchResolver] Tavily 429 rate limit exceeded all retries.');
            break;
          }
        }

        if (!response.ok) {
          console.warn(
            `[TavilySearchResolver] Tavily API returned HTTP ${response.status}: ${response.statusText}`
          );
          break;
        }

        const data = (await response.json()) as TavilySearchResponse;
        const results = data?.results || [];

        for (const item of results) {
          if (!item.url) continue;
          const cleanDomain = normalizeDomain(item.url);
          if (!cleanDomain || isRejectedSearchDomain(cleanDomain)) {
            continue;
          }

          // Build clean structured candidate (internal score preserved for ranking, never exposed as confidence)
          candidates.push({
            domain: cleanDomain,
            websiteUrl: `https://${cleanDomain}`,
            title: item.title?.trim() || cleanDomain,
            snippet: item.content?.trim() || '',
            score: typeof item.score === 'number' ? item.score : 0.8,
            provider: 'TAVILY',
            query: searchQuery,
          } as ResolutionCandidate);
        }

        break; // Successfully fetched and parsed
      } catch (err: any) {
        console.warn(`[TavilySearchResolver] Error querying Tavily for "${searchQuery}":`, err?.message);
        break;
      }
    }

    // Memoize candidates in cache
    this.searchCache.set(cacheKey, candidates);
    return candidates;
  }
}

export function createTavilySearchResolver(options?: TavilyResolverOptions) {
  const resolver = new TavilySearchResolver(options);
  return (query: string) => resolver.resolve(query);
}

export const defaultTavilyResolverInstance = new TavilySearchResolver();
export const tavilySearchResolver = (query: string) => defaultTavilyResolverInstance.resolve(query);
