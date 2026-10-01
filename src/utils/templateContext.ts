import Handlebars from 'handlebars';

/**
 * Builds a canonical variable resolution context from a contact or enrollment record.
 * Guarantees identical variable resolution between Preview, Test Email, and Campaign Dispatch.
 * Zero mock company fallbacks.
 */
export interface CanonicalLeadContext {
  firstName: string;
  lastName: string;
  email: string;
  title: string;
  companyName: string;
  website: string;
  industry: string;
  companySize: string;
  companyPhone: string;
  personLinkedinUrl: string;
  city: string;
  personalization: string;
  personalizedLine: string;
  senderName: string;
  senderCompany: string;
  unsubscribeLink: string;
  [key: string]: string;
}

export function buildCanonicalLeadContext(
  lead: any,
  senderName: string = 'Arup Nirala',
  senderCompany: string = 'TripGain',
  unsubscribeLink: string = '#'
): CanonicalLeadContext {
  if (!lead) {
    return {
      firstName: '',
      lastName: '',
      email: '',
      title: '',
      companyName: '',
      website: '',
      industry: '',
      companySize: '',
      companyPhone: '',
      personLinkedinUrl: '',
      city: '',
      personalization: '',
      personalizedLine: '',
      senderName,
      senderCompany,
      unsubscribeLink
    };
  }

  const pers = (
    lead.personalizedLine ||
    lead.personalization ||
    lead.personalizationTrigger ||
    ''
  ).trim();

  const company = (
    lead.companyName ||
    lead.company ||
    lead.organization?.name ||
    ''
  ).trim();

  const email = (
    lead.email ||
    (Array.isArray(lead.emails) ? (lead.emails.find((e: any) => e?.isPrimary)?.email || lead.emails[0]?.email) : '') ||
    ''
  ).trim();

  return {
    firstName: (lead.firstName || '').trim(),
    lastName: (lead.lastName || '').trim(),
    email,
    title: (lead.jobTitle || lead.title || '').trim(),
    companyName: company,
    website: (lead.website || lead.organization?.domain || '').trim(),
    industry: (lead.industry || lead.organization?.industry || '').trim(),
    companySize: (lead.companySize || lead.organization?.employeeSize || '').trim(),
    companyPhone: (lead.companyPhone || lead.organization?.phone || '').trim(),
    personLinkedinUrl: (lead.personLinkedinUrl || lead.linkedinUrl || '').trim(),
    city: (lead.city || '').trim(),
    personalization: pers,
    personalizedLine: pers,
    senderName,
    senderCompany,
    unsubscribeLink
  };
}

/**
 * Normalizes email HTML:
 * 1. Strips ghost/empty paragraphs (<p></p>, <p><br></p>, <p>&nbsp;</p>) that cause unsightly double spaces.
 * 2. Formats signature blocks compactly: merges sign-offs (e.g. "Best,", "Regards,") and consecutive
 *    sender lines (Name, Company, Title, Phone) into a single <p> separated by <br>, eliminating
 *    accidental paragraph gaps in email signatures.
 */
export function normalizeEmailHtml(html: string): string {
  if (!html) return '';

  // 1. Strip empty paragraphs
  let clean = html.replace(/<p[^>]*>\s*(?:<br\s*\/?>|&nbsp;|\s)*<\/p>/gi, '');

  // 2. Unwrap any <p> tags directly inside <li> tags and ensure compact line spacing
  clean = clean.replace(/<li([^>]*)>\s*<p[^>]*>([\s\S]*?)<\/p>\s*<\/li>/gi, '<li$1 style="margin-bottom:3px;line-height:1.45;">$2</li>');
  clean = clean.replace(/<li(?![^>]*style=)([^>]*)>/gi, '<li$1 style="margin-bottom:3px;line-height:1.45;">');

  // 3. Convert consecutive bullet paragraphs (<p>• ...</p> or <p>- ...</p>) into compact <ul><li>
  const bulletParaRegex = /(?:<p[^>]*>\s*(?:[•\u2022\u25E6\u2219]|-|\*)\s*[\s\S]*?<\/p>\s*)+/gi;
  clean = clean.replace(bulletParaRegex, (match) => {
    const itemRegex = /<p[^>]*>\s*(?:[•\u2022\u25E6\u2219]|-|\*)\s*([\s\S]*?)<\/p>/gi;
    const items: string[] = [];
    let m;
    while ((m = itemRegex.exec(match)) !== null) {
      if (m[1]) {
        items.push(`<li style="margin-bottom:3px;line-height:1.45;">${m[1].trim()}</li>`);
      }
    }
    return `<ul style="margin:8px 0 12px 0;padding-left:20px;list-style-type:disc;">${items.join('')}</ul>`;
  });

  // 4. Convert consecutive numbered paragraphs (<p>1. ...</p> or <p>1) ...</p>) into compact <ol><li>
  const numberedParaRegex = /(?:<p[^>]*>\s*\d+[\.\)]\s*[\s\S]*?<\/p>\s*)+/gi;
  clean = clean.replace(numberedParaRegex, (match) => {
    const itemRegex = /<p[^>]*>\s*\d+[\.\)]\s*([\s\S]*?)<\/p>/gi;
    const items: string[] = [];
    let m;
    while ((m = itemRegex.exec(match)) !== null) {
      if (m[1]) {
        items.push(`<li style="margin-bottom:3px;line-height:1.45;">${m[1].trim()}</li>`);
      }
    }
    return `<ol style="margin:8px 0 12px 0;padding-left:20px;list-style-type:decimal;">${items.join('')}</ol>`;
  });

  // 5. Identify sign-off paragraph (e.g. <p>Best,</p>, <p>Regards,</p>, etc.)
  const signoffPattern = /<p[^>]*>\s*(?:(Best(?:[\s\u00A0]+regards)?|Warm(?:[\s\u00A0]+regards)?|Kind(?:[\s\u00A0]+regards)?|Regards|Thanks(?:[\s\u00A0]*(?:&|&amp;|and)[\s\u00A0]*regards)?|Thank[\s\u00A0]+you|Sincerely|Cheers|With[\s\u00A0]+regards|Yours[\s\u00A0]+truly|Talk[\s\u00A0]+soon|Many[\s\u00A0]+thanks)[,!.]?)\s*<\/p>/i;

  const match = signoffPattern.exec(clean);
  if (match) {
    const signoffIdx = match.index;
    const beforeSignoff = clean.slice(0, signoffIdx);
    const fromSignoff = clean.slice(signoffIdx);

    const pTagRegex = /^<p[^>]*>([\s\S]*?)<\/p>/i;
    let remainder = fromSignoff;
    const signatureLines: string[] = [];

    while (true) {
      const pMatch = pTagRegex.exec(remainder);
      if (!pMatch || !pMatch[1]) break;
      const content = pMatch[1].trim();
      const textOnly = content.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

      // Skip blank empty paragraphs in signature section
      if (!textOnly) {
        remainder = remainder.slice(pMatch[0].length).trim();
        continue;
      }

      // Stop if block elements, unsubscribe link, or long paragraphs (>80 chars) encountered
      if (
        signatureLines.length > 0 &&
        (textOnly.length > 80 ||
          /unsubscribe/i.test(content) ||
          /<(?:blockquote|table|ul|ol|h[1-6]|hr|div)/i.test(content))
      ) {
        break;
      }

      signatureLines.push(content);
      remainder = remainder.slice(pMatch[0].length).trim();
      if (signatureLines.length >= 6) break;
    }

    if (signatureLines.length > 1) {
      const flattened = signatureLines.flatMap(line =>
        line.split(/<br\s*\/?>/i).map(l => l.trim()).filter(Boolean)
      );
      const compactSignature = `<p class="email-signature" style="margin-bottom:0;line-height:1.4;">${flattened.join('<br>')}</p>`;
      clean = beforeSignoff + compactSignature + (remainder ? (remainder.startsWith('<') ? remainder : ' ' + remainder) : '');
    }
  }

  return clean;
}

/**
 * Sanitizes template strings before Handlebars compilation:
 * 1. Replaces all non-breaking spaces (&nbsp;, &#160;, \u00A0) with standard spaces.
 * 2. Decodes common entities that may have leaked inside {{...}} blocks.
 * 3. Strips HTML tags injected inside {{...}} by rich text editors (e.g. {{<span>firstName</span>}}).
 * 4. Normalizes Handlebars helper blocks (e.g. {{#if&nbsp;var}} -> {{#if var}}).
 */
export function sanitizeHandlebarsTemplate(raw: string): string {
  if (!raw) return '';

  let text = raw;

  // 1. Replace non-breaking spaces across the whole document
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/gi, ' ')
    .replace(/&#xA0;/gi, ' ')
    .replace(/\u00A0/g, ' ');

  // 2. Decode entities inside handlebars tags
  text = text
    .replace(/&#125;/g, '}')
    .replace(/&#x7D;/gi, '}')
    .replace(/&#123;/g, '{')
    .replace(/&#x7B;/gi, '{');

  // 3. Clean inside {{ ... }} blocks: strip rogue HTML formatting tags and normalize whitespace
  text = text.replace(/\{\{([^{}]+)\}\}/g, (_match, inner) => {
    // Strip HTML tags inside tag
    let cleaned = inner.replace(/<[^>]+>/g, '').trim();
    // Normalize any residual whitespace or &nbsp; inside the tag
    cleaned = cleaned.replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ');
    return `{{${cleaned}}}`;
  });

  return text;
}

/**
 * Compiles and renders a template string with Handlebars safely.
 * If Handlebars parsing fails due to user syntax error or malformed blocks,
 * falls back to regex-based variable replacement without throwing an unhandled parse error.
 */
export function safeRenderTemplate(
  templateStr: string,
  context: Record<string, any>,
  fallbackDefault: string = ''
): string {
  const sanitized = sanitizeHandlebarsTemplate(templateStr || fallbackDefault);
  if (!sanitized) return fallbackDefault;

  try {
    const compiled = Handlebars.compile(sanitized, { noEscape: true });
    return compiled(context);
  } catch (err: any) {
    console.warn('[TemplateEngine] Handlebars compilation failed, applying resilient fallback:', err?.message);
    let fallbackText = sanitized;
    try {
      // Resolve {{#if key}}...{{else}}...{{/if}}
      fallbackText = fallbackText.replace(
        /\{\{#if\s+([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/gi,
        (_, key, truthy, falsy) => {
          const val = context[key];
          return val && String(val).trim() !== '' ? truthy : falsy;
        }
      );
      // Resolve {{#if key}}...{{/if}}
      fallbackText = fallbackText.replace(
        /\{\{#if\s+([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/if\}\}/gi,
        (_, key, content) => {
          const val = context[key];
          return val && String(val).trim() !== '' ? content : '';
        }
      );
      // Resolve {{key}}
      fallbackText = fallbackText.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
        const val = context[key];
        return val !== undefined && val !== null ? String(val) : '';
      });
      // Strip any unhandled residual {{...}}
      fallbackText = fallbackText.replace(/\{\{[^}]+\}\}/g, '');
      return fallbackText;
    } catch {
      return sanitized;
    }
  }
}

