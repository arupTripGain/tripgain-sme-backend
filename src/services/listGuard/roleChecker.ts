/**
 * Role Account Detection for ListGuard
 * Detects common role addresses.
 * IMPORTANT: Role account != invalid email.
 * Role accounts are informational deliverability signals, NOT automatically undeliverable.
 */

const ROLE_PREFIXES = new Set<string>([
  'info',
  'sales',
  'support',
  'admin',
  'administrator',
  'contact',
  'hello',
  'office',
  'accounts',
  'billing',
  'hr',
  'careers',
  'jobs',
  'marketing',
  'help',
  'helpdesk',
  'team',
  'service',
  'services',
  'enquiries',
  'enquiry',
  'inquiry',
  'inquiries',
  'press',
  'media',
  'pr',
  'legal',
  'security',
  'compliance',
  'privacy',
  'finance',
  'payments',
  'invoice',
  'orders',
  'operations',
  'ops',
  'dev',
  'engineering',
  'tech',
  'general',
  'reception',
  'postmaster',
  'hostmaster',
  'webmaster',
  'abuse',
  'noc',
  'root',
  'mailer-daemon',
  'noreply',
  'no-reply'
]);

export function isRoleAccount(localPart: string): boolean {
  if (!localPart) return false;
  const clean = localPart.toLowerCase().trim();
  
  // Direct match e.g. "info", "support"
  if (ROLE_PREFIXES.has(clean)) {
    return true;
  }

  // Common separator variations e.g. "sales.team", "support_india", "office-desk"
  const prefix = clean.split(/[._+-]/)[0];
  if (prefix && ROLE_PREFIXES.has(prefix)) {
    return true;
  }

  return false;
}
