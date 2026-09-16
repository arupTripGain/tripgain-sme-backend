import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface DedupeResult {
  dedupeStatus: 'UNIQUE' | 'DUPLICATE' | 'POSSIBLE_DUPLICATE';
  duplicateConfidence: number | null;
  duplicateReason: string | null;
  duplicateLeadId: string | null;
}

/**
 * Calculates bigram-based Dice similarity coefficient (0.0 to 1.0)
 */
export function stringSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().replace(/\s+/g, '');
  const s2 = str2.toLowerCase().replace(/\s+/g, '');

  if (s1 === s2) return 1.0;
  if (s1.length < 2 || s2.length < 2) return 0.0;

  const getBigrams = (str: string) => {
    const bigrams = new Map<string, number>();
    for (let i = 0; i < str.length - 1; i++) {
      const bigram = str.substring(i, i + 2);
      bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
    }
    return bigrams;
  };

  const b1 = getBigrams(s1);
  const b2 = getBigrams(s2);

  let intersection = 0;
  for (const [key, count] of b1.entries()) {
    if (b2.has(key)) {
      intersection += Math.min(count, b2.get(key)!);
    }
  }

  const total = (s1.length - 1) + (s2.length - 1);
  return (2.0 * intersection) / total;
}

/**
 * Scans existing user/workspace leads for duplicates using the 5-tier conservative hierarchy.
 */
export async function evaluateDuplicate(
  userId: string,
  workspaceId: string | null | undefined,
  lead: {
    domain?: string | null;
    email?: string | null;
    companyNormalizedName: string;
    companyName: string;
    city?: string | null;
    phone?: string | null;
  },
  excludeLeadId?: string
): Promise<DedupeResult> {
  const userScope: any = { userId };
  if (workspaceId) {
    // If workspace provided, scope to workspace or user
    userScope.OR = [{ userId }, { workspaceId }];
  }

  const baseFilter: any = { ...userScope };
  if (excludeLeadId) {
    baseFilter.id = { not: excludeLeadId };
  }

  // Tier 1: Exact Domain Match (if valid domain provided)
  if (lead.domain && lead.domain.length > 3) {
    const domainMatch = await prisma.leadIntelligenceLead.findFirst({
      where: {
        ...baseFilter,
        domain: lead.domain.toLowerCase(),
      },
      select: { id: true, companyName: true, domain: true },
    });

    if (domainMatch) {
      return {
        dedupeStatus: 'DUPLICATE',
        duplicateConfidence: 1.0,
        duplicateReason: `Exact domain match (${lead.domain}) with existing lead "${domainMatch.companyName}"`,
        duplicateLeadId: domainMatch.id,
      };
    }
  }

  // Tier 2: Exact Email Match (if valid email provided)
  if (lead.email && lead.email.includes('@')) {
    const emailMatch = await prisma.leadIntelligenceLead.findFirst({
      where: {
        ...baseFilter,
        email: lead.email.toLowerCase(),
      },
      select: { id: true, companyName: true, email: true },
    });

    if (emailMatch) {
      return {
        dedupeStatus: 'DUPLICATE',
        duplicateConfidence: 1.0,
        duplicateReason: `Exact email match (${lead.email}) with existing lead "${emailMatch.companyName}"`,
        duplicateLeadId: emailMatch.id,
      };
    }
  }

  // Tier 3: Company Normalized Name + City Match
  if (lead.companyNormalizedName && lead.companyNormalizedName.length >= 3 && lead.city && lead.city.trim().length >= 2) {
    const nameAndCityMatch = await prisma.leadIntelligenceLead.findFirst({
      where: {
        ...baseFilter,
        companyNormalizedName: lead.companyNormalizedName,
        city: { equals: lead.city.trim(), mode: 'insensitive' },
      },
      select: { id: true, companyName: true, city: true },
    });

    if (nameAndCityMatch) {
      return {
        dedupeStatus: 'DUPLICATE',
        duplicateConfidence: 0.95,
        duplicateReason: `Normalized company name & city match (${lead.companyName}, ${lead.city}) with existing lead "${nameAndCityMatch.companyName}"`,
        duplicateLeadId: nameAndCityMatch.id,
      };
    }
  }

  // Tier 4: Exact Phone Match -> POSSIBLE_DUPLICATE (Conservative: phone could be a shared call center or switchboard)
  if (lead.phone && lead.phone.replace(/\D/g, '').length >= 7) {
    const cleanDigits = lead.phone.replace(/\D/g, '');
    const phoneMatch = await prisma.leadIntelligenceLead.findFirst({
      where: {
        ...baseFilter,
        phone: { contains: cleanDigits },
      },
      select: { id: true, companyName: true, phone: true },
    });

    if (phoneMatch) {
      return {
        dedupeStatus: 'POSSIBLE_DUPLICATE',
        duplicateConfidence: 0.85,
        duplicateReason: `Matching phone number (${lead.phone}) with existing lead "${phoneMatch.companyName}"`,
        duplicateLeadId: phoneMatch.id,
      };
    }
  }

  // Tier 5: Fuzzy Company Name Similarity (> 0.88) -> POSSIBLE_DUPLICATE
  if (lead.companyNormalizedName && lead.companyNormalizedName.length >= 4) {
    // Find candidate leads sharing first 3 characters to avoid scanning entire DB
    const prefix = lead.companyNormalizedName.slice(0, 3);
    const candidates = await prisma.leadIntelligenceLead.findMany({
      where: {
        ...baseFilter,
        companyNormalizedName: { startsWith: prefix },
      },
      select: { id: true, companyName: true, companyNormalizedName: true },
      take: 50,
    });

    for (const cand of candidates) {
      const similarity = stringSimilarity(lead.companyNormalizedName, cand.companyNormalizedName);
      if (similarity >= 0.88) {
        return {
          dedupeStatus: 'POSSIBLE_DUPLICATE',
          duplicateConfidence: Math.round(similarity * 100) / 100,
          duplicateReason: `High company name similarity (${Math.round(similarity * 100)}%) with existing lead "${cand.companyName}"`,
          duplicateLeadId: cand.id,
        };
      }
    }
  }

  return {
    dedupeStatus: 'UNIQUE',
    duplicateConfidence: null,
    duplicateReason: null,
    duplicateLeadId: null,
  };
}

export interface ExistingLeadRecord {
  id: string;
  domain: string | null;
  email: string | null;
  companyNormalizedName: string;
  companyName: string;
  city: string | null;
  phone: string | null;
}

/**
 * In-memory batch deduplication engine.
 * Preloads existing leads once from the database and performs the exact same 5-tier conservative
 * hierarchy in memory (sub-millisecond per lead), completely eliminating thousands of sequential
 * database roundtrips and connection drop errors.
 */
export class BatchDeduplicator {
  private byDomain = new Map<string, ExistingLeadRecord>();
  private byEmail = new Map<string, ExistingLeadRecord>();
  private byCompanyAndCity = new Map<string, ExistingLeadRecord>();
  private byCleanPhone = new Map<string, ExistingLeadRecord>();
  private byPrefix = new Map<string, ExistingLeadRecord[]>();

  constructor(existingRecords: ExistingLeadRecord[]) {
    for (const rec of existingRecords) {
      this.addRecord(rec);
    }
  }

  public addRecord(rec: ExistingLeadRecord) {
    if (rec.domain && rec.domain.length > 3) {
      const d = rec.domain.toLowerCase().trim();
      if (!this.byDomain.has(d)) this.byDomain.set(d, rec);
    }
    if (rec.email && rec.email.includes('@')) {
      const e = rec.email.toLowerCase().trim();
      if (!this.byEmail.has(e)) this.byEmail.set(e, rec);
    }
    if (rec.companyNormalizedName && rec.city && rec.city.trim().length >= 2) {
      const key = `${rec.companyNormalizedName.toLowerCase().trim()}|${rec.city.toLowerCase().trim()}`;
      if (!this.byCompanyAndCity.has(key)) this.byCompanyAndCity.set(key, rec);
    }
    if (rec.phone) {
      const cleanDigits = rec.phone.replace(/\D/g, '');
      if (cleanDigits.length >= 7) {
        if (!this.byCleanPhone.has(cleanDigits)) this.byCleanPhone.set(cleanDigits, rec);
      }
    }
    if (rec.companyNormalizedName && rec.companyNormalizedName.length >= 4) {
      const prefix = rec.companyNormalizedName.slice(0, 3).toLowerCase();
      const list = this.byPrefix.get(prefix) || [];
      list.push(rec);
      this.byPrefix.set(prefix, list);
    }
  }

  public evaluate(lead: {
    domain?: string | null;
    email?: string | null;
    companyNormalizedName: string;
    companyName: string;
    city?: string | null;
    phone?: string | null;
  }): DedupeResult {
    // Tier 1: Exact Domain Match
    if (lead.domain && lead.domain.length > 3) {
      const match = this.byDomain.get(lead.domain.toLowerCase().trim());
      if (match) {
        return {
          dedupeStatus: 'DUPLICATE',
          duplicateConfidence: 1.0,
          duplicateReason: `Exact domain match (${lead.domain}) with existing lead "${match.companyName}"`,
          duplicateLeadId: match.id,
        };
      }
    }

    // Tier 2: Exact Email Match
    if (lead.email && lead.email.includes('@')) {
      const match = this.byEmail.get(lead.email.toLowerCase().trim());
      if (match) {
        return {
          dedupeStatus: 'DUPLICATE',
          duplicateConfidence: 1.0,
          duplicateReason: `Exact email match (${lead.email}) with existing lead "${match.companyName}"`,
          duplicateLeadId: match.id,
        };
      }
    }

    // Tier 3: Company Normalized Name + City Match
    if (lead.companyNormalizedName && lead.companyNormalizedName.length >= 3 && lead.city && lead.city.trim().length >= 2) {
      const key = `${lead.companyNormalizedName.toLowerCase().trim()}|${lead.city.toLowerCase().trim()}`;
      const match = this.byCompanyAndCity.get(key);
      if (match) {
        return {
          dedupeStatus: 'DUPLICATE',
          duplicateConfidence: 0.95,
          duplicateReason: `Normalized company name & city match (${lead.companyName}, ${lead.city}) with existing lead "${match.companyName}"`,
          duplicateLeadId: match.id,
        };
      }
    }

    // Tier 4: Exact Phone Match -> POSSIBLE_DUPLICATE
    if (lead.phone) {
      const cleanDigits = lead.phone.replace(/\D/g, '');
      if (cleanDigits.length >= 7) {
        const match = this.byCleanPhone.get(cleanDigits);
        if (match) {
          return {
            dedupeStatus: 'POSSIBLE_DUPLICATE',
            duplicateConfidence: 0.85,
            duplicateReason: `Matching phone number (${lead.phone}) with existing lead "${match.companyName}"`,
            duplicateLeadId: match.id,
          };
        }
      }
    }

    // Tier 5: Fuzzy Company Name Similarity (> 0.88)
    if (lead.companyNormalizedName && lead.companyNormalizedName.length >= 4) {
      const prefix = lead.companyNormalizedName.slice(0, 3).toLowerCase();
      const candidates = this.byPrefix.get(prefix) || [];
      for (const cand of candidates.slice(0, 50)) {
        const similarity = stringSimilarity(lead.companyNormalizedName, cand.companyNormalizedName);
        if (similarity >= 0.88) {
          return {
            dedupeStatus: 'POSSIBLE_DUPLICATE',
            duplicateConfidence: Math.round(similarity * 100) / 100,
            duplicateReason: `High company name similarity (${Math.round(similarity * 100)}%) with existing lead "${cand.companyName}"`,
            duplicateLeadId: cand.id,
          };
        }
      }
    }

    return {
      dedupeStatus: 'UNIQUE',
      duplicateConfidence: null,
      duplicateReason: null,
      duplicateLeadId: null,
    };
  }
}

/**
 * Creates and loads a BatchDeduplicator instance for a given user/workspace.
 */
export async function createBatchDeduplicator(
  userId: string,
  workspaceId?: string | null
): Promise<BatchDeduplicator> {
  const userScope: any = workspaceId ? { OR: [{ userId }, { workspaceId }] } : { userId };

  const existingLeads = await prisma.leadIntelligenceLead.findMany({
    where: userScope,
    select: {
      id: true,
      domain: true,
      email: true,
      companyNormalizedName: true,
      companyName: true,
      city: true,
      phone: true,
    },
  });

  return new BatchDeduplicator(existingLeads);
}

