import { AIProviderService } from './ai';

export type FieldDetectionStatus = 'DETECTED' | 'NEEDS_REVIEW' | 'NOT_FOUND' | 'INVALID';

export interface ParsedLeadData {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string | null;
  jobTitle: string | null;
  companyName: string | null;
  linkedinUrl: string | null;
  companyLinkedinUrl: string | null;
  websiteUrl: string | null;
}

export interface FieldStatusMap {
  name: FieldDetectionStatus;
  email: FieldDetectionStatus;
  jobTitle: FieldDetectionStatus;
  company: FieldDetectionStatus;
  linkedin: FieldDetectionStatus;
  website: FieldDetectionStatus;
}

export interface ParseLeadResult {
  success: boolean;
  parsed: ParsedLeadData;
  fieldStatus: FieldStatusMap;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  sourceText: string;
  error?: string | undefined;
  warnings?: string[] | undefined;
}

const TITLE_KEYWORDS = [
  'founder', 'co-founder', 'cofounder', 'co founder',
  'ceo', 'cfo', 'cto', 'cmo', 'coo', 'cro', 'cio', 'cpo', 'chro', 'clo', 'cso',
  'chief executive', 'chief technology', 'chief operating', 'chief financial', 'chief marketing',
  'president', 'vice president', 'vp', 'svp', 'evp', 'avp',
  'director', 'managing director', 'executive director',
  'head of', 'head', 'lead', 'team lead',
  'manager', 'general manager', 'gm',
  'partner', 'managing partner', 'owner', 'principal',
  'consultant', 'advisor', 'senior', 'strategist', 'specialist',
  'analyst', 'associate', 'engineer', 'architect',
  'executive', 'admin', 'administrator', 'officer', 'representative',
  'developer', 'designer', 'coordinator', 'assistant', 'recruiter', 'hr', 'human resources'
];

const LEGAL_SUFFIXES = [
  'inc', 'inc.', 'llc', 'llc.', 'ltd', 'ltd.', 'pvt ltd', 'pvt. ltd.', 'private limited',
  'corp', 'corp.', 'corporation', 'gmbh', 'co', 'co.', 'company', 'holdings', 'group',
  'enterprises', 'ventures', 'technologies', 'solutions', 'systems', 'labs', 'software'
];

const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'mail.com', 'protonmail.com', 'zoho.com', 'rediffmail.com', 'aol.com', 'yandex.com'
]);

/**
 * Capitalizes string nicely (e.g. referrush -> ReferRush or Referrush)
 */
function cleanCompanyNameFromDomain(domain: string): string {
  if (!domain) return '';
  const base = domain.split('.')[0] || domain;
  if (!base) return '';
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Normalizes a URL: removes tracking query parameters, hashes, trailing slashes,
 * and canonicalizes protocol.
 */
export function normalizeUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  try {
    const parsed = new URL(url);
    // Remove tracking params
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'isselfprofile', 'fbclid', 'gclid', 'ref', 'source'];
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (trackingParams.includes(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    // Reconstruct without empty search/hash
    let clean = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    // Strip trailing slash if path is longer than 1 or if root
    if (clean.endsWith('/') && (clean.split('/').length > 4 || clean.endsWith('://' + parsed.host + '/'))) {
      clean = clean.replace(/\/+$/, '');
    }
    if (parsed.search) {
      clean += parsed.search;
    }
    return clean;
  } catch {
    return url.replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

/**
 * Deterministic lead parser that extracts email, URLs, name, job title, and company
 * in the requested priority order.
 */
export function parseLeadDeterministic(rawText: string): ParseLeadResult {
  const result: ParsedLeadData = {
    firstName: '',
    lastName: '',
    fullName: '',
    email: null,
    jobTitle: null,
    companyName: null,
    linkedinUrl: null,
    companyLinkedinUrl: null,
    websiteUrl: null
  };

  const fieldStatus: FieldStatusMap = {
    name: 'NOT_FOUND',
    email: 'NOT_FOUND',
    jobTitle: 'NOT_FOUND',
    company: 'NOT_FOUND',
    linkedin: 'NOT_FOUND',
    website: 'NOT_FOUND'
  };

  const warnings: string[] = [];

  if (!rawText || !rawText.trim()) {
    return {
      success: false,
      parsed: result,
      fieldStatus,
      confidence: 'LOW',
      sourceText: rawText || '',
      error: 'Empty input provided'
    };
  }

  // Pre-process lines
  let lines: string[] = rawText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  if (lines.length === 0) {
    return {
      success: false,
      parsed: result,
      fieldStatus,
      confidence: 'LOW',
      sourceText: rawText,
      error: 'No recognizable information found'
    };
  }

  // Step 1: Detect Email
  const emailRegex = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/i;
  let detectedEmail: string | null = null;
  let remainingLines: string[] = [];

  for (const line of lines) {
    const match = line.match(emailRegex);
    if (match && match[0] && !detectedEmail) {
      detectedEmail = match[0].toLowerCase().trim();
      const stripped = line.replace(match[0], '').trim();
      if (stripped.length > 1) {
        remainingLines.push(stripped);
      }
    } else {
      remainingLines.push(line);
    }
  }

  // Check for malformed email attempts in text if no valid email found
  if (detectedEmail) {
    result.email = detectedEmail;
    fieldStatus.email = 'DETECTED';
  } else {
    // Check if any line looks like an invalid email e.g. "user@", "user@referrush" (missing tld)
    const malformedEmailMatch = rawText.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]*\b/);
    if (malformedEmailMatch && malformedEmailMatch[0] && !malformedEmailMatch[0].includes('.')) {
      fieldStatus.email = 'INVALID';
      warnings.push(`Malformed email detected: ${malformedEmailMatch[0]}`);
    } else {
      fieldStatus.email = 'NOT_FOUND';
    }
  }

  lines = remainingLines;
  remainingLines = [];

  // Step 2: Detect LinkedIn URLs
  // Matches linkedin.com/in/... or linkedin.com/company/...
  const linkedinPersonalRegex = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)\/?(?:[^\s]*)?/i;
  const linkedinCompanyRegex = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/company\/([a-zA-Z0-9\-_%]+)\/?(?:[^\s]*)?/i;

  for (const line of lines) {
    let modifiedLine = line;
    
    // Check personal LinkedIn
    const personalMatch = modifiedLine.match(linkedinPersonalRegex);
    if (personalMatch && personalMatch[0] && !result.linkedinUrl) {
      const fullUrl = personalMatch[0];
      result.linkedinUrl = normalizeUrl(fullUrl);
      fieldStatus.linkedin = 'DETECTED';
      modifiedLine = modifiedLine.replace(fullUrl, '').trim();
    }

    // Check company LinkedIn
    const companyMatch = modifiedLine.match(linkedinCompanyRegex);
    if (companyMatch && companyMatch[0] && !result.companyLinkedinUrl) {
      const fullUrl = companyMatch[0];
      result.companyLinkedinUrl = normalizeUrl(fullUrl);
      modifiedLine = modifiedLine.replace(fullUrl, '').trim();
    }

    if (modifiedLine.length > 1) {
      remainingLines.push(modifiedLine);
    }
  }

  lines = remainingLines;
  remainingLines = [];

  // Step 3: Detect Company Website (HTTP/HTTPS or domain not belonging to LinkedIn/social)
  const websiteRegex = /(?:https?:\/\/|www\.)[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?:\/[^\s]*)?|\b[a-zA-Z0-9-]+\.(?:com|org|io|net|co|ai|in|co\.uk|app|dev|biz|tech|us|me|info|agency|global|travel)(?:\/[^\s]*)?\b/i;

  for (const line of lines) {
    const match = line.match(websiteRegex);
    if (match && match[0] && !result.websiteUrl) {
      const rawUrl = match[0];
      // Skip if it contains linkedin.com
      if (!/linkedin\.com/i.test(rawUrl) && !/twitter\.com|x\.com|facebook\.com|instagram\.com/i.test(rawUrl)) {
        result.websiteUrl = normalizeUrl(rawUrl);
        fieldStatus.website = 'DETECTED';
        const stripped = line.replace(rawUrl, '').trim();
        if (stripped.length > 1) {
          remainingLines.push(stripped);
        }
        continue;
      }
    }
    remainingLines.push(line);
  }

  lines = remainingLines;

  // Step 4: Extract Name, Job Title, and Company from remaining lines
  const separatorRegex = /(?:,\s*|\s+(?:at|@)\s+|\s*[/|]{1,2}\s*|\s*[-–—]\s*)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const hasSeparator = separatorRegex.test(line);
    const hasTitleKeyword = TITLE_KEYWORDS.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(line));

    if (hasTitleKeyword) {
      if (hasSeparator) {
        // Handle special case: "Founder & CEO, ReferRush, Inc." (comma in company name)
        const parts = line.split(/,\s*/);
        const part0 = parts[0];
        if (parts.length >= 2 && part0) {
          const part0HasTitle = TITLE_KEYWORDS.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(part0));
          if (part0HasTitle) {
            result.jobTitle = part0.trim();
            fieldStatus.jobTitle = 'DETECTED';
            const compParts = parts.slice(1).map(p => p.trim()).filter(Boolean);
            result.companyName = compParts.join(', ');
            fieldStatus.company = 'DETECTED';
            lines[i] = '';
            continue;
          }

          // Company first: "ReferRush, Inc., Founder & CEO"
          const lastPart = parts[parts.length - 1];
          if (lastPart) {
            const lastPartHasTitle = TITLE_KEYWORDS.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(lastPart));
            if (lastPartHasTitle) {
              result.jobTitle = lastPart.trim();
              fieldStatus.jobTitle = 'DETECTED';
              const compParts = parts.slice(0, parts.length - 1).map(p => p.trim()).filter(Boolean);
              result.companyName = compParts.join(', ');
              fieldStatus.company = 'DETECTED';
              lines[i] = '';
              continue;
            }
          }
        }

        // Check other separators: " at ", " @ ", " - ", " | ", "//", "/", etc.
        const nonCommaSep = line.match(/(?:\s+(?:at|@|[-–—])\s+|\s*[/|]{1,2}\s*|\s*[-–—]\s*)/i);
        if (nonCommaSep && nonCommaSep.index !== undefined && nonCommaSep[0]) {
          const left = line.slice(0, nonCommaSep.index).trim();
          const right = line.slice(nonCommaSep.index + nonCommaSep[0].length).trim();
          const leftHasTitle = TITLE_KEYWORDS.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(left));
          const rightHasTitle = TITLE_KEYWORDS.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(right));

          if (leftHasTitle) {
            result.jobTitle = left;
            fieldStatus.jobTitle = 'DETECTED';
            result.companyName = right;
            fieldStatus.company = 'DETECTED';
            lines[i] = '';
            continue;
          } else if (rightHasTitle) {
            result.companyName = left;
            result.jobTitle = right;
            fieldStatus.jobTitle = 'DETECTED';
            fieldStatus.company = 'DETECTED';
            lines[i] = '';
            continue;
          }
        }
      }

      // If line has title keyword but no separator, check if it contains company name
      if (!result.jobTitle) {
        let inferredComp = '';
        if (result.websiteUrl) {
          try {
            const host = new URL(result.websiteUrl).hostname.replace(/^www\./, '');
            inferredComp = cleanCompanyNameFromDomain(host);
          } catch {}
        } else if (result.email) {
          const parts = result.email.split('@');
          const domain = parts[1];
          if (domain && !PUBLIC_EMAIL_DOMAINS.has(domain)) {
            inferredComp = cleanCompanyNameFromDomain(domain);
          }
        }

        const compMatch = inferredComp ? line.match(new RegExp(`\\b${inferredComp}\\b`, 'i')) : null;
        if (compMatch && compMatch[0]) {
          // Company is embedded in the title line - preserve original text casing
          result.companyName = compMatch[0];
          fieldStatus.company = 'DETECTED';
          result.jobTitle = line.replace(new RegExp(`^${compMatch[0]}\\s+`, 'i'), '').trim();
          fieldStatus.jobTitle = 'DETECTED';
          lines[i] = '';
          continue;
        }

        result.jobTitle = line;
        fieldStatus.jobTitle = 'DETECTED';
        lines[i] = '';
        continue;
      }
    }
  }

  // Filter out consumed lines
  const remaining = lines.map(l => (l || '').trim()).filter(l => l.length > 0);

  // Identify Human Name vs standalone Company
  for (let i = 0; i < remaining.length; i++) {
    const line = remaining[i];
    if (!line) continue;

    const isCompanyIndicator = LEGAL_SUFFIXES.some(s => new RegExp(`\\b${s}\\b`, 'i').test(line));
    const isLikelyName = /^[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['.-][A-Za-zÀ-ÖØ-öø-ÿ]+)*(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['.-][A-Za-zÀ-ÖØ-öø-ÿ]+)*){0,3}$/.test(line);

    if (isLikelyName && !isCompanyIndicator && !result.fullName) {
      const nameParts = line.split(/\s+/);
      result.firstName = nameParts[0] || '';
      result.lastName = nameParts.slice(1).join(' ') || '';
      result.fullName = line;
      fieldStatus.name = 'DETECTED';
      remaining[i] = '';
      continue;
    }
  }

  // If company still not found, check remaining non-empty lines with valid alphabetic content
  const stillRemaining = remaining
    .map(l => (l || '').trim())
    .filter(l => l.length > 0 && /[a-zA-ZÀ-ÖØ-öø-ÿ]{2,}/.test(l));

  const firstRemaining = stillRemaining[0];
  const legalCompLine = stillRemaining.find(l => LEGAL_SUFFIXES.some(s => new RegExp(`\\b${s}\\b`, 'i').test(l)));
  if (legalCompLine) {
    result.companyName = legalCompLine;
    fieldStatus.company = 'DETECTED';
  } else if (!result.companyName && firstRemaining) {
    result.companyName = firstRemaining;
    fieldStatus.company = 'DETECTED';
  } else if (!result.fullName && firstRemaining) {
    const nameParts = firstRemaining.split(/\s+/);
    result.firstName = nameParts[0] || '';
    result.lastName = nameParts.slice(1).join(' ') || '';
    result.fullName = firstRemaining;
    fieldStatus.name = 'NEEDS_REVIEW';
  }

  // Step 5: Additional Evidence for Company if not explicitly detected
  if (!result.companyName) {
    if (result.companyLinkedinUrl) {
      const match = result.companyLinkedinUrl.match(/company\/([a-zA-Z0-9\-_%]+)/i);
      if (match && match[1]) {
        result.companyName = cleanCompanyNameFromDomain(match[1]);
        fieldStatus.company = 'NEEDS_REVIEW';
      }
    } else if (result.websiteUrl) {
      try {
        const host = new URL(result.websiteUrl).hostname.replace(/^www\./, '');
        result.companyName = cleanCompanyNameFromDomain(host);
        fieldStatus.company = 'NEEDS_REVIEW';
      } catch {}
    } else if (result.email) {
      const parts = result.email.split('@');
      const domain = parts[1];
      if (domain && !PUBLIC_EMAIL_DOMAINS.has(domain)) {
        result.companyName = cleanCompanyNameFromDomain(domain);
        fieldStatus.company = 'NEEDS_REVIEW';
      }
    }
  }

  // Final check: did we detect ANY recognizable lead info?
  const hasRecognizableInfo = Boolean(
    result.email ||
    result.fullName ||
    result.linkedinUrl ||
    result.websiteUrl ||
    result.companyName ||
    result.jobTitle
  );

  if (!hasRecognizableInfo) {
    return {
      success: false,
      parsed: result,
      fieldStatus,
      confidence: 'LOW',
      sourceText: rawText,
      error: 'No recognizable lead information found'
    };
  }

  let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
  const detectedCount = Object.values(fieldStatus).filter(s => s === 'DETECTED').length;
  if (detectedCount >= 3) {
    confidence = 'HIGH';
  } else if (detectedCount >= 1) {
    confidence = 'MEDIUM';
  }

  return {
    success: true,
    parsed: result,
    fieldStatus,
    confidence,
    sourceText: rawText,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

/**
 * Optional AI Fallback parser if deterministic parser produces ambiguous results
 */
export async function parseLeadWithAiFallback(
  rawText: string,
  userId?: string
): Promise<ParseLeadResult> {
  const deterministicResult = parseLeadDeterministic(rawText);

  if (deterministicResult.confidence === 'HIGH' || !userId) {
    return deterministicResult;
  }

  const isAmbiguous = (
    !deterministicResult.parsed.fullName ||
    !deterministicResult.parsed.jobTitle
  ) && rawText.trim().split(/\r?\n/).length > 1;

  if (!isAmbiguous) {
    return deterministicResult;
  }

  try {
    const systemPrompt = `You are a strict data extraction system. Parse the unstructured lead text into JSON.
Return ONLY valid JSON matching this exact structure:
{
  "firstName": "string or empty",
  "lastName": "string or empty",
  "fullName": "string or empty",
  "email": "string or null",
  "jobTitle": "string or null",
  "companyName": "string or null",
  "linkedinUrl": "string or null",
  "websiteUrl": "string or null"
}
Rules:
- Do NOT invent or fabricate information. If a field is not present in the input, return null or empty string.
- Never override strong emails or URLs if already present.
- Output ONLY the raw JSON object, without backticks or markdown formatting.`;

    const aiRes = await AIProviderService.generateText({
      userId,
      feature: 'OTHER_AI_FEATURE',
      systemPrompt,
      userPrompt: `Extract lead info from this text:\n\n${rawText}`,
      temperature: 0.1
    });

    if (aiRes && aiRes.text) {
      let cleaned = aiRes.text.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      }
      const aiParsed = JSON.parse(cleaned);

      const merged: ParsedLeadData = {
        firstName: deterministicResult.parsed.firstName || aiParsed.firstName || '',
        lastName: deterministicResult.parsed.lastName || aiParsed.lastName || '',
        fullName: deterministicResult.parsed.fullName || aiParsed.fullName || `${aiParsed.firstName || ''} ${aiParsed.lastName || ''}`.trim(),
        email: deterministicResult.parsed.email || aiParsed.email || null,
        jobTitle: deterministicResult.parsed.jobTitle || aiParsed.jobTitle || null,
        companyName: deterministicResult.parsed.companyName || aiParsed.companyName || null,
        linkedinUrl: deterministicResult.parsed.linkedinUrl || (aiParsed.linkedinUrl ? normalizeUrl(aiParsed.linkedinUrl) : null),
        companyLinkedinUrl: deterministicResult.parsed.companyLinkedinUrl,
        websiteUrl: deterministicResult.parsed.websiteUrl || (aiParsed.websiteUrl ? normalizeUrl(aiParsed.websiteUrl) : null)
      };

      const status = { ...deterministicResult.fieldStatus };
      if (merged.fullName && status.name === 'NOT_FOUND') status.name = 'NEEDS_REVIEW';
      if (merged.jobTitle && status.jobTitle === 'NOT_FOUND') status.jobTitle = 'NEEDS_REVIEW';
      if (merged.companyName && status.company === 'NOT_FOUND') status.company = 'NEEDS_REVIEW';

      return {
        success: true,
        parsed: merged,
        fieldStatus: status,
        confidence: 'MEDIUM',
        sourceText: rawText
      };
    }
  } catch (aiErr) {
    console.warn('[SmartLeadParser] AI fallback skipped or failed:', aiErr);
  }

  return deterministicResult;
}
