/**
 * Robust Email Syntax Validator for ListGuard
 * Checks email syntax thoroughly without relying solely on a simplistic regex.
 */

export interface SyntaxCheckResult {
  isValid: boolean;
  status: 'PASS' | 'FAIL';
  reason?: string;
}

export function checkEmailSyntax(email: string): SyntaxCheckResult {
  if (!email || typeof email !== 'string') {
    return { isValid: false, status: 'FAIL', reason: 'Email is empty or not a string' };
  }

  const trimmed = email.trim();
  if (trimmed.length > 254) {
    return { isValid: false, status: 'FAIL', reason: 'Email exceeds maximum length of 254 characters' };
  }

  // Must contain exactly one @ symbol
  const atParts = trimmed.split('@');
  if (atParts.length !== 2) {
    return { isValid: false, status: 'FAIL', reason: 'Email must contain exactly one @ symbol' };
  }

  const [localPart, domain] = atParts as [string, string];

  // Local part validation
  if (!localPart || localPart.length === 0) {
    return { isValid: false, status: 'FAIL', reason: 'Local part cannot be empty' };
  }
  if (localPart.length > 64) {
    return { isValid: false, status: 'FAIL', reason: 'Local part exceeds 64 characters' };
  }
  if (localPart.startsWith('.') || localPart.endsWith('.')) {
    return { isValid: false, status: 'FAIL', reason: 'Local part cannot start or end with a dot' };
  }
  if (localPart.includes('..')) {
    return { isValid: false, status: 'FAIL', reason: 'Local part cannot contain consecutive dots' };
  }

  // Local part character check (allowing RFC 5322 characters: letters, digits, and specific symbols)
  const validLocalRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
  if (!validLocalRegex.test(localPart)) {
    return { isValid: false, status: 'FAIL', reason: 'Local part contains invalid characters' };
  }

  // Domain validation
  if (!domain || domain.length === 0) {
    return { isValid: false, status: 'FAIL', reason: 'Domain part cannot be empty' };
  }
  if (domain.length > 255) {
    return { isValid: false, status: 'FAIL', reason: 'Domain exceeds 255 characters' };
  }
  if (domain.startsWith('.') || domain.endsWith('.')) {
    return { isValid: false, status: 'FAIL', reason: 'Domain cannot start or end with a dot' };
  }
  if (domain.includes('..')) {
    return { isValid: false, status: 'FAIL', reason: 'Domain cannot contain consecutive dots' };
  }

  const domainLabels = domain.split('.');
  if (domainLabels.length < 2) {
    return { isValid: false, status: 'FAIL', reason: 'Domain must contain at least one dot separating name and TLD' };
  }

  for (const label of domainLabels) {
    if (label.length === 0) {
      return { isValid: false, status: 'FAIL', reason: 'Domain label cannot be empty' };
    }
    if (label.length > 63) {
      return { isValid: false, status: 'FAIL', reason: 'Domain label exceeds 63 characters' };
    }
    if (label.startsWith('-') || label.endsWith('-')) {
      return { isValid: false, status: 'FAIL', reason: 'Domain label cannot start or end with a hyphen' };
    }
    const validLabelRegex = /^[a-zA-Z0-9-]+$/;
    if (!validLabelRegex.test(label)) {
      return { isValid: false, status: 'FAIL', reason: 'Domain label contains invalid characters' };
    }
  }

  // TLD validation (last label): must be at least 2 characters and letters only
  const tld = domainLabels[domainLabels.length - 1];
  if (!tld || tld.length < 2 || !/^[a-zA-Z]+$/.test(tld)) {
    return { isValid: false, status: 'FAIL', reason: 'Top-level domain must be at least 2 alphabetic characters' };
  }

  return { isValid: true, status: 'PASS' };
}
