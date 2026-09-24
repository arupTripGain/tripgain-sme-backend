/**
 * Normalization Service for Lead Intelligence
 * Deterministic, rule-based field cleaning and scoring.
 */

const COMPANY_SUFFIX_REGEX = /(?:^|\b|\s)(inc\.?|incorporated|llc|l\.l\.c\.?|ltd\.?|limited|pvt\.?\s*ltd\.?|private\s+limited|corp\.?|corporation|llp|gmbh\s*&\s*co\.?\s*kg|gmbh|kg|plc|s\.a\.|s\.a|b\.v\.|b\.v|holdings?|group|co\.?|company)(?=\b|\s|$|[.,;])/gi;

/**
 * Parses trade names, divisions, subsidiaries, and parent company notations.
 * Examples:
 * - "Agrayan (A Division of Digite infotech Pvt. Ltd.)" -> base: "Agrayan", parent: "Digite infotech Pvt. Ltd."
 * - "Acme Dynamics [Div. of Apex Global]" -> base: "Acme Dynamics", parent: "Apex Global"
 * - "Brand X - Division of Company Y" -> base: "Brand X", parent: "Company Y"
 * - "Brand X (formerly Brand Z)" -> base: "Brand X", parent: null
 */
export function parseCompanyDivision(rawName: string | null | undefined): {
  rawName: string;
  baseName: string;
  parentCompany: string | null;
  relationshipType: 'DIVISION' | 'SUBSIDIARY' | 'FORMER_NAME' | null;
} {
  if (!rawName || !rawName.trim()) {
    return { rawName: '', baseName: '', parentCompany: null, relationshipType: null };
  }

  const trimmed = rawName.trim();

  // Pattern 1: Parenthetical or bracketed division of parent
  // e.g. "Agrayan (A Division of Digite infotech Pvt. Ltd.)" or "Nova Robotics (A Division of CyberCorp)"
  const parenDivisionMatch = trimmed.match(/^(.+?)\s*[(\[]\s*(?:a\s+)?(?:division\s+of|div\.?\s+of)\s+([^\])]+)[)\]]/i);
  if (parenDivisionMatch && parenDivisionMatch[1] && parenDivisionMatch[2]) {
    return {
      rawName: trimmed,
      baseName: parenDivisionMatch[1].trim(),
      parentCompany: parenDivisionMatch[2].trim(),
      relationshipType: 'DIVISION',
    };
  }

  // Pattern 1b: Parenthetical internal division name
  // e.g. "Amada America Inc (Laser & Sheet Metal Machinery Division)" or "Siemens (Digital Industries Div)"
  const internalDivMatch = trimmed.match(/^(.+?)\s*[(\[]\s*([^\])]*?\b(?:division|div\.?))\s*[)\]]/i);
  if (internalDivMatch && internalDivMatch[1] && internalDivMatch[2]) {
    return {
      rawName: trimmed,
      baseName: internalDivMatch[1].trim(),
      parentCompany: internalDivMatch[1].trim(),
      relationshipType: 'DIVISION',
    };
  }

  // Pattern 2: Hyphenated / slashed division
  // e.g. "Agrayan - A Division of Digite Infotech"
  const hyphenDivisionMatch = trimmed.match(/^(.+?)\s*[-–—]\s*(?:a\s+)?(?:division\s+of|div\.?\s+of)\s+(.+)$/i);
  if (hyphenDivisionMatch && hyphenDivisionMatch[1] && hyphenDivisionMatch[2]) {
    return {
      rawName: trimmed,
      baseName: hyphenDivisionMatch[1].trim(),
      parentCompany: hyphenDivisionMatch[2].trim(),
      relationshipType: 'DIVISION',
    };
  }

  // Pattern 3: Subsidiary
  // e.g. "Acme Corp (Subsidiary of Global Conglomerate)"
  const parenSubMatch = trimmed.match(/^(.+?)\s*[(\[]\s*(?:a\s+)?(?:subsidiary\s+of|sub\.?\s+of)\s+([^\])]+)[)\]]/i);
  if (parenSubMatch && parenSubMatch[1] && parenSubMatch[2]) {
    return {
      rawName: trimmed,
      baseName: parenSubMatch[1].trim(),
      parentCompany: parenSubMatch[2].trim(),
      relationshipType: 'SUBSIDIARY',
    };
  }

  // Pattern 4: Former name notation
  // e.g. "NexGen Travel (formerly Orbitz Media)"
  const formerNameMatch = trimmed.match(/^(.+?)\s*\(\s*(?:formerly|f\/k\/a|fka)\s+([^)]+)\)$/i);
  if (formerNameMatch && formerNameMatch[1] && formerNameMatch[2]) {
    return {
      rawName: trimmed,
      baseName: formerNameMatch[1].trim(),
      parentCompany: null,
      relationshipType: 'FORMER_NAME',
    };
  }

  return {
    rawName: trimmed,
    baseName: trimmed,
    parentCompany: null,
    relationshipType: null,
  };
}

/**
 * Normalizes a company name for deterministic duplicate matching and indexing:
 * - Detects trade name / division and uses the primary brand entity
 * - Removes common legal entity suffixes (Inc, LLC, Pvt Ltd, etc.)
 * - Strips punctuation and special characters
 * - Collapses multiple spaces
 * - Returns lowercase trimmed string
 */
export function normalizeCompanyName(name: string | null | undefined): string {
  if (!name) return '';
  
  // Extract base brand name if parenthetical division exists
  const parsed = parseCompanyDivision(name);
  let cleaned = parsed.baseName;
  
  // Remove entity suffixes
  cleaned = cleaned.replace(COMPANY_SUFFIX_REGEX, '');
  
  // Remove non-alphanumeric chars except spaces and apostrophes (Unicode-aware)
  cleaned = cleaned.replace(/[^\p{L}\p{N}\s'’]/gu, ' ');
  
  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim().toLowerCase();
  return cleaned;
}

/**
 * Normalizes a domain or website URL:
 * - Strips protocol (http://, https://)
 * - Strips leading 'www.'
 * - Strips trailing slashes, paths, query parameters, and hashes
 * - Lowercases the domain
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let raw = input.trim();
  if (!raw) return null;

  try {
    if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
      raw = 'http://' + raw;
    }
    const parsed = new URL(raw);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('www.')) {
      host = host.slice(4);
    }
    // Must contain at least one dot and valid characters
    if (host.includes('.') && !host.includes(' ') && host.length >= 4) {
      return host;
    }
  } catch {
    // Fallback regex if URL parsing fails
    const match = input.match(/(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z0-9.-]+)/i);
    if (match && match[1]) {
      return match[1].toLowerCase().replace(/^www\./, '');
    }
  }

  return null;
}

/**
 * Normalizes email:
 * - Strips 'mailto:'
 * - Lowercases and trims
 * - Verifies basic structural validity
 */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  let cleaned = email.trim().toLowerCase();
  if (cleaned.startsWith('mailto:')) {
    cleaned = cleaned.slice(7).trim();
  }
  
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (emailRegex.test(cleaned)) {
    return cleaned;
  }
  return null;
}

/**
 * Normalizes phone numbers:
 * - Strips extraneous characters while keeping leading + if international
 * - Verifies that at least 7 digits exist
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith('+');
  const digitsOnly = trimmed.replace(/\D/g, '');
  
  if (digitsOnly.length < 7 || digitsOnly.length > 15) {
    return null;
  }

  return hasPlus ? `+${digitsOnly}` : digitsOnly;
}

/**
 * Validates whether a domain is valid
 */
export function isValidDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(domain);
}

/**
 * Calculates a completeness score (0.0 - 1.0) based on present attributes.
 */
export function calculateCompletenessScore(lead: {
  companyName?: string | null | undefined;
  domain?: string | null | undefined;
  websiteUrl?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  contactName?: string | null | undefined;
  contactTitle?: string | null | undefined;
  city?: string | null | undefined;
  industry?: string | null | undefined;
}): number {
  let score = 0;
  
  // Weights total 1.0
  if (lead.companyName && lead.companyName.trim().length > 0) score += 0.25;
  if (lead.domain || lead.websiteUrl) score += 0.20;
  if (lead.email) score += 0.20;
  if (lead.phone) score += 0.10;
  if (lead.contactName) score += 0.10;
  if (lead.contactTitle) score += 0.05;
  if (lead.city) score += 0.05;
  if (lead.industry) score += 0.05;

  return Math.min(1.0, Math.round(score * 100) / 100);
}

/**
 * Full normalization pass on an extracted lead object
 */
export function normalizeLeadPayload(lead: {
  companyName: string;
  rawName?: string | null | undefined;
  domain?: string | null | undefined;
  websiteUrl?: string | null | undefined;
  boothNumber?: string | null | undefined;
  hallNumber?: string | null | undefined;
  category?: string | null | undefined;
  detailUrl?: string | null | undefined;
  sourceUrl?: string | null | undefined;
  contactName?: string | null | undefined;
  contactTitle?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  country?: string | null | undefined;
  address?: string | null | undefined;
  industry?: string | null | undefined;
  companySize?: string | null | undefined;
  linkedinUrl?: string | null | undefined;
  sourceType: string;
  sourceName: string;
  provenance?: any;
}) {
  const normEmail = normalizeEmail(lead.email);
  const normDomain = normalizeDomain(lead.domain || lead.websiteUrl);
  const normPhone = normalizePhone(lead.phone);
  const divisionInfo = parseCompanyDivision(lead.companyName || lead.rawName);
  const cleanCompanyName = (divisionInfo.relationshipType && divisionInfo.baseName) ? divisionInfo.baseName : (lead.companyName || lead.rawName);
  const normCompName = normalizeCompanyName(cleanCompanyName);

  const hasValidEmail = !!normEmail;
  const hasValidDomain = !!normDomain;
  const hasValidPhone = !!normPhone;

  const completeness = calculateCompletenessScore({
    companyName: lead.companyName,
    domain: normDomain,
    websiteUrl: lead.websiteUrl,
    email: normEmail,
    phone: normPhone,
    contactName: lead.contactName,
    contactTitle: lead.contactTitle,
    city: lead.city,
    industry: lead.industry,
  });

  const mergedProvenance = {
    ...(lead.provenance || {}),
    ...(divisionInfo.relationshipType ? { divisionInfo } : {}),
  };

  return {
    rawName: (lead.rawName || lead.companyName).trim(),
    companyName: (divisionInfo.relationshipType && divisionInfo.baseName) ? divisionInfo.baseName : lead.companyName.trim(),
    companyNormalizedName: normCompName,
    domain: normDomain,
    websiteUrl: lead.websiteUrl ? lead.websiteUrl.trim() : (normDomain ? `https://${normDomain}` : null),
    boothNumber: lead.boothNumber?.trim() || null,
    hallNumber: lead.hallNumber?.trim() || null,
    category: lead.category?.trim() || null,
    detailUrl: lead.detailUrl?.trim() || null,
    sourceUrl: lead.sourceUrl?.trim() || null,
    contactName: lead.contactName?.trim() || null,
    contactTitle: lead.contactTitle?.trim() || null,
    email: normEmail,
    phone: normPhone,
    city: lead.city?.trim() || null,
    state: lead.state?.trim() || null,
    country: lead.country?.trim() || null,
    address: lead.address?.trim() || null,
    industry: lead.industry?.trim() || null,
    companySize: lead.companySize?.trim() || null,
    linkedinUrl: lead.linkedinUrl?.trim() || null,
    sourceType: lead.sourceType,
    sourceName: lead.sourceName,
    provenance: mergedProvenance,
    hasValidEmail,
    hasValidDomain,
    hasValidPhone,
    completenessScore: completeness,
  };
}
