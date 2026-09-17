/**
 * Normalizes email addresses per ListGuard specifications:
 * - trim leading and trailing whitespace
 * - lowercase conversion
 * - extracts local-part and domain
 */

export interface NormalizedEmailResult {
  rawEmail: string;
  normalizedEmail: string;
  localPart: string;
  domain: string;
  isValidFormat: boolean;
}

export function normalizeEmail(rawEmail: string): NormalizedEmailResult {
  if (!rawEmail || typeof rawEmail !== 'string') {
    return {
      rawEmail: '',
      normalizedEmail: '',
      localPart: '',
      domain: '',
      isValidFormat: false
    };
  }

  const trimmed = rawEmail.trim().toLowerCase();
  // Remove any inner whitespace or tabs if present
  const cleaned = trimmed.replace(/[\s\t\r\n]+/g, '');
  
  const atIndex = cleaned.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === cleaned.length - 1) {
    return {
      rawEmail,
      normalizedEmail: cleaned,
      localPart: atIndex > 0 ? cleaned.slice(0, atIndex) : cleaned,
      domain: atIndex > 0 ? cleaned.slice(atIndex + 1) : '',
      isValidFormat: false
    };
  }

  const localPart = cleaned.slice(0, atIndex);
  const domain = cleaned.slice(atIndex + 1);

  return {
    rawEmail,
    normalizedEmail: cleaned,
    localPart,
    domain,
    isValidFormat: true
  };
}
