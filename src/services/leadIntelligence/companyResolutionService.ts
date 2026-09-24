import { PrismaClient } from '@prisma/client';
import { normalizeDomain, normalizeCompanyName, parseCompanyDivision } from './normalizationService';

const prisma = new PrismaClient();

export type ResolutionStatus =
  | 'RESOLVED_HIGH'
  | 'RESOLVED_MEDIUM'
  | 'RESOLVED_LOW'
  | 'REVIEW_REQUIRED'
  | 'UNRESOLVED';

export type ResolutionSource = 'DIRECTORY' | 'DATABASE' | 'SEARCH' | 'MANUAL';

export interface ResolutionCandidate {
  domain: string;
  websiteUrl?: string;
  url?: string;
  title?: string;
  snippet?: string;
  score?: number;
  provider?: string;
  query?: string;
}

export interface ResolutionEvidence {
  source: ResolutionSource | null;
  evidence: string;
  candidateDomain?: string | null;
  candidates?: ResolutionCandidate[];
  criteriaMatched?: string[];
  provider?: string;
  query?: string;
}

export interface CompanyResolutionResult {
  domain: string | null;
  websiteUrl: string | null;
  resolutionStatus: ResolutionStatus;
  resolutionSource: ResolutionSource | null;
  resolutionEvidence: ResolutionEvidence;
  resolvedAt: Date | null;
}

const SOCIAL_AND_GENERIC_DOMAINS = new Set([
  'facebook.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'instagram.com',
  'youtube.com',
  'pinterest.com',
  'tiktok.com',
  'wikipedia.org',
  'google.com',
  'yahoo.com',
  'bing.com',
  'medium.com',
  'reddit.com',
  'github.com',
  'mapyourshow.com',
  'xpressreg.net',
  'npe.org',
  'packexpointernational.com',
  'eventbrite.com',
  'smallworldlabs.com',
  'a2zinc.net',
  'mya2zevents.com',
  'fabtechexpo.com',
  'fabtech.com',
]);

/**
 * Checks whether a domain is a third-party social or generic hosting platform
 * rather than an official company website.
 */
export function isInvalidCompanyDomain(domain: string | null | undefined): boolean {
  if (!domain) return true;
  const lower = domain.toLowerCase().trim();
  for (const generic of SOCIAL_AND_GENERIC_DOMAINS) {
    if (lower === generic || lower.endsWith('.' + generic)) {
      return true;
    }
  }
  return false;
}

export interface ResolveCompanyParams {
  rawName: string;
  companyName: string;
  companyNormalizedName: string;
  websiteUrl?: string | null;
  domain?: string | null;
  city?: string | null;
  category?: string | null;
  sourceUrl?: string | null;
  userId?: string;
  workspaceId?: string | null;
  searchResolver?: (query: string) => Promise<ResolutionCandidate[]>;
}

export class CompanyResolutionService {
  // In-memory resolution cache per batch execution to prevent duplicate lookups
  private resolutionCache = new Map<string, CompanyResolutionResult>();

  // Rate limiter for search lookups (respectful QPS pacing)
  private lastSearchTimestamp = 0;
  private minSearchIntervalMs = 50;

  /**
   * Clears the in-memory memoization cache
   */
  public clearCache(): void {
    this.resolutionCache.clear();
  }

  /**
   * Resolves an exhibitor company's website and domain using strict evidence hierarchy:
   * 1. Directory-provided official website
   * 2. Existing verified database record (Organization or confirmed lead)
   * 3. Configured search resolver (if available) with bounded queries
   * 4. Unresolved fallback (strictly NO domain guessing)
   */
  public async resolveCompany(params: ResolveCompanyParams): Promise<CompanyResolutionResult> {
    const cacheKey = `${params.workspaceId || params.userId || 'global'}:${params.companyNormalizedName}`;
    if (this.resolutionCache.has(cacheKey)) {
      return this.resolutionCache.get(cacheKey)!;
    }

    // -------------------------------------------------------------
    // TIER 1: Official Website from Exhibitor Directory Listing
    // -------------------------------------------------------------
    const directoryRawUrl = params.websiteUrl || params.domain;
    if (directoryRawUrl) {
      const normalized = normalizeDomain(directoryRawUrl);
      if (normalized && !isInvalidCompanyDomain(normalized)) {
        // Confirm it is not identical to the directory source domain itself
        let isSameAsDirectoryHost = false;
        if (params.sourceUrl) {
          const sourceDomain = normalizeDomain(params.sourceUrl);
          if (sourceDomain && normalized === sourceDomain) {
            isSameAsDirectoryHost = true;
          }
        }

        if (!isSameAsDirectoryHost) {
          const result: CompanyResolutionResult = {
            domain: normalized,
            websiteUrl: `https://${normalized}`,
            resolutionStatus: 'RESOLVED_HIGH',
            resolutionSource: 'DIRECTORY',
            resolutionEvidence: {
              source: 'DIRECTORY',
              evidence: 'Official website link explicitly found in exhibitor directory listing',
              candidateDomain: normalized,
              criteriaMatched: ['DIRECTORY_EXPLICIT_URL'],
            },
            resolvedAt: new Date(),
          };
          this.resolutionCache.set(cacheKey, result);
          return result;
        }
      }
    }

    // -------------------------------------------------------------
    // TIER 2: Existing Trusted Workspace Database Match
    // -------------------------------------------------------------
    if (params.workspaceId && (params.companyNormalizedName || params.rawName)) {
      try {
        const div = parseCompanyDivision(params.rawName || params.companyName);
        const baseNorm = div.baseName ? normalizeCompanyName(div.baseName) : null;

        const targetNames: string[] = [params.companyName];
        if (params.companyNormalizedName && params.companyNormalizedName !== params.companyName) {
          targetNames.push(params.companyNormalizedName);
        }
        if (div.baseName && !targetNames.includes(div.baseName)) {
          targetNames.push(div.baseName);
        }
        if (baseNorm && !targetNames.includes(baseNorm)) {
          targetNames.push(baseNorm);
        }

        // Query Organization table for exact case-insensitive match
        const matchingOrg = await prisma.organization.findFirst({
          where: {
            workspaceId: params.workspaceId,
            domain: { not: null },
            OR: targetNames.map((name) => ({
              name: { equals: name, mode: 'insensitive' },
            })),
          },
          select: { name: true, domain: true, websiteUrl: true },
        });

        if (matchingOrg && matchingOrg.domain) {
          const cleanDomain = normalizeDomain(matchingOrg.domain);
          if (cleanDomain && !isInvalidCompanyDomain(cleanDomain)) {
            const result: CompanyResolutionResult = {
              domain: cleanDomain,
              websiteUrl: matchingOrg.websiteUrl || `https://${cleanDomain}`,
              resolutionStatus: 'RESOLVED_HIGH',
              resolutionSource: 'DATABASE',
              resolutionEvidence: {
                source: 'DATABASE',
                evidence: `Exact company name match with verified workspace organization (${matchingOrg.name})`,
                candidateDomain: cleanDomain,
                criteriaMatched: ['WORKSPACE_ORGANIZATION_MATCH'],
              },
              resolvedAt: new Date(),
            };
            this.resolutionCache.set(cacheKey, result);
            return result;
          }
        }

        // Also check previously resolved HIGH leads in the workspace
        const prevLead = await prisma.leadIntelligenceLead.findFirst({
          where: {
            workspaceId: params.workspaceId,
            resolutionStatus: 'RESOLVED_HIGH',
            domain: { not: null },
            OR: [
              { companyNormalizedName: params.companyNormalizedName },
              ...(baseNorm ? [{ companyNormalizedName: baseNorm }] : []),
              ...targetNames.map((name) => ({
                companyName: { equals: name, mode: 'insensitive' as const },
              })),
            ],
          },
          select: { domain: true, websiteUrl: true, companyName: true },
        });

        if (prevLead && prevLead.domain) {
          const cleanDomain = normalizeDomain(prevLead.domain);
          if (cleanDomain && !isInvalidCompanyDomain(cleanDomain)) {
            const result: CompanyResolutionResult = {
              domain: cleanDomain,
              websiteUrl: prevLead.websiteUrl || `https://${cleanDomain}`,
              resolutionStatus: 'RESOLVED_HIGH',
              resolutionSource: 'DATABASE',
              resolutionEvidence: {
                source: 'DATABASE',
                evidence: `Exact normalized company match with prior verified lead record (${prevLead.companyName})`,
                candidateDomain: cleanDomain,
                criteriaMatched: ['WORKSPACE_PRIOR_VERIFIED_LEAD'],
              },
              resolvedAt: new Date(),
            };
            this.resolutionCache.set(cacheKey, result);
            return result;
          }
        }
      } catch (err) {
        console.warn(`[CompanyResolutionService] Error during DB check for ${params.companyNormalizedName}:`, err);
      }
    }

    // -------------------------------------------------------------
    // TIER 3: Configured Search Resolver (if available)
    // -------------------------------------------------------------
    if (params.searchResolver && typeof params.searchResolver === 'function') {
      try {
        // Enforce rate limiter pacing before executing search query
        const now = Date.now();
        const waitTime = this.minSearchIntervalMs - (now - this.lastSearchTimestamp);
        if (waitTime > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
        this.lastSearchTimestamp = Date.now();

        const query = `${params.companyName} ${params.city || ''} ${params.category || ''}`.trim();
        const candidates = await params.searchResolver(query);

        // Filter out social, directory, and invalid domains
        const validCandidates = (candidates || []).filter(
          (c) => c.domain && !isInvalidCompanyDomain(normalizeDomain(c.domain))
        );

        const providerName = (candidates && candidates[0]?.provider) || 'TAVILY';

        // Keep ranking/scoring metrics strictly internal to the algorithm;
        // preserve candidate identity, URLs, and titles for human review without exposing numeric scores.
        const preservedCandidates: ResolutionCandidate[] = validCandidates.map((c) => {
          const item: ResolutionCandidate = {
            domain: normalizeDomain(c.domain) || c.domain,
            websiteUrl: c.websiteUrl || `https://${normalizeDomain(c.domain) || c.domain}`,
            url: c.url || c.websiteUrl || `https://${normalizeDomain(c.domain) || c.domain}`,
          };
          if (c.title) item.title = c.title;
          if (c.snippet) item.snippet = c.snippet;
          return item;
        });

        if (validCandidates.length === 1 && validCandidates[0]) {
          const best = validCandidates[0];
          const cleanDomain = normalizeDomain(best.domain)!;
          const isWeak = (best.score !== undefined && best.score < 0.75);

          if (isWeak) {
            // Weak indirect evidence -> REVIEW_REQUIRED with domain = null, candidate preserved in evidence
            const result: CompanyResolutionResult = {
              domain: null,
              websiteUrl: null,
              resolutionStatus: 'REVIEW_REQUIRED',
              resolutionSource: 'SEARCH',
              resolutionEvidence: {
                source: 'SEARCH',
                evidence: `Weak candidate domain returned from search query without strong brand match (${best.title || cleanDomain}); human review required`,
                candidateDomain: cleanDomain,
                candidates: preservedCandidates,
                criteriaMatched: ['SEARCH_WEAK_SIGNAL'],
                provider: providerName,
                query,
              },
              resolvedAt: null,
            };
            this.resolutionCache.set(cacheKey, result);
            return result;
          }

          // Strong direct/corroborated single candidate -> RESOLVED_MEDIUM, domain populated
          const result: CompanyResolutionResult = {
            domain: cleanDomain,
            websiteUrl: best.websiteUrl || `https://${cleanDomain}`,
            resolutionStatus: 'RESOLVED_MEDIUM',
            resolutionSource: 'SEARCH',
            resolutionEvidence: {
              source: 'SEARCH',
              evidence: `Single corroborated candidate domain returned from search query matching company identity (${best.title || cleanDomain})`,
              candidateDomain: cleanDomain,
              candidates: preservedCandidates,
              criteriaMatched: ['SEARCH_SINGLE_CANDIDATE'],
              provider: providerName,
              query,
            },
            resolvedAt: new Date(),
          };
          this.resolutionCache.set(cacheKey, result);
          return result;
        }

        if (validCandidates.length > 1) {
          // Multiple conflicting candidates found -> require human review
          const candidateDomains = Array.from(new Set(validCandidates.map((c) => normalizeDomain(c.domain)!)));
          
          if (candidateDomains.length === 1) {
            // All candidates point to the same root domain
            const cleanDomain = candidateDomains[0]!;
            const result: CompanyResolutionResult = {
              domain: cleanDomain,
              websiteUrl: `https://${cleanDomain}`,
              resolutionStatus: 'RESOLVED_MEDIUM',
              resolutionSource: 'SEARCH',
              resolutionEvidence: {
                source: 'SEARCH',
                evidence: 'Multiple search results converged on a single unique domain',
                candidateDomain: cleanDomain,
                candidates: preservedCandidates,
                criteriaMatched: ['SEARCH_CONVERGENT_DOMAIN'],
                provider: providerName,
                query,
              },
              resolvedAt: new Date(),
            };
            this.resolutionCache.set(cacheKey, result);
            return result;
          }

          // Conflicting distinct candidate domains
          const result: CompanyResolutionResult = {
            domain: null,
            websiteUrl: null,
            resolutionStatus: 'REVIEW_REQUIRED',
            resolutionSource: 'SEARCH',
            resolutionEvidence: {
              source: 'SEARCH',
              evidence: `Multiple conflicting domain candidates discovered (${candidateDomains.slice(0, 3).join(', ')}); human review required`,
              candidateDomain: validCandidates[0]?.domain || null,
              candidates: preservedCandidates,
              criteriaMatched: ['SEARCH_CONFLICTING_CANDIDATES'],
              provider: providerName,
              query,
            },
            resolvedAt: null,
          };
          this.resolutionCache.set(cacheKey, result);
          return result;
        }
      } catch (err: any) {
        console.warn(`[CompanyResolutionService] Search resolver error for ${params.companyName}:`, err?.message);
      }
    }

    // -------------------------------------------------------------
    // TIER 4: Unresolved Fallback (Zero Domain Guessing)
    // -------------------------------------------------------------
    const unresolvedResult: CompanyResolutionResult = {
      domain: null,
      websiteUrl: null,
      resolutionStatus: 'UNRESOLVED',
      resolutionSource: null,
      resolutionEvidence: {
        source: null,
        evidence: 'No reliable domain evidence discovered from directory, database, or configured resolvers',
        candidateDomain: null,
        candidates: [],
        criteriaMatched: ['NO_EVIDENCE'],
      },
      resolvedAt: null,
    };

    this.resolutionCache.set(cacheKey, unresolvedResult);
    return unresolvedResult;
  }
}

export const companyResolutionService = new CompanyResolutionService();
