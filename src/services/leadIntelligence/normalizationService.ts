/**
 * Normalization Service for Lead Intelligence
 * Deterministic, rule-based field cleaning and scoring.
 */

const COMPANY_SUFFIX_REGEX = /\b(inc\.?|incorporated|llc|l\.l\.c\.?|ltd\.?|limited|pvt\.?\s*ltd\.?|private\s+limited|corp\.?|corporation|co\.?|company|llp|gmbh|plc|s\.a\.|b\.v\.|holdings?|group)\b/gi;

/**
 * Normalizes a company name for deterministic duplicate matching and indexing:
 * - Removes common legal entity suffixes (Inc, LLC, Pvt Ltd, etc.)
 * - Strips punctuation and special characters
 * - Collapses multiple spaces
 * - Returns lowercase trimmed string
 */
export function normalizeCompanyName(name: string | null | undefined): string {
  if (!name) return '';
  let cleaned = name.trim();
  
  // Remove entity suffixes
  cleaned = cleaned.replace(COMPANY_SUFFIX_REGEX, '');
  
  // Remove non-alphanumeric chars except spaces
  cleaned = cleaned.replace(/[^\w\s]/gi, ' ');
  
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
  domain?: string | null | undefined;
  websiteUrl?: string | null | undefined;
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
  const normCompName = normalizeCompanyName(lead.companyName);

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

  return {
    companyName: lead.companyName.trim(),
    companyNormalizedName: normCompName,
    domain: normDomain,
    websiteUrl: lead.websiteUrl ? lead.websiteUrl.trim() : (normDomain ? `https://${normDomain}` : null),
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
    provenance: lead.provenance || null,
    hasValidEmail,
    hasValidDomain,
    hasValidPhone,
    completenessScore: completeness,
  };
}
