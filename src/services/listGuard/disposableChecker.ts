/**
 * Disposable Email Domain Intelligence for ListGuard
 * Detects temporary/disposable mailbox providers.
 * Extensible design for updating domain datasets.
 */

// Core known disposable email domains
const DEFAULT_DISPOSABLE_DOMAINS = new Set<string>([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.biz',
  'guerrillamail.de',
  'guerrillamail.net',
  'guerrillamail.org',
  'sharklasers.com',
  'grr.la',
  'temp-mail.org',
  'tempmail.com',
  'tempmail.net',
  '10minutemail.com',
  '10minutemail.net',
  'throwawaymail.com',
  'trashmail.com',
  'trashmail.net',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'dispostable.com',
  'fakeinbox.com',
  'emailondeck.com',
  'mohmal.com',
  'getairmail.com',
  'maildrop.cc',
  'inboxkitten.com',
  'burnermail.io',
  'generator.email',
  'mytemp.email',
  'crazymailing.com',
  'dropmail.me',
  'nada.ltd',
  'getnada.com',
  'fakemailgenerator.com',
  'tempail.com',
  'armyspy.com',
  'cuvox.de',
  'dayrep.com',
  'einrot.com',
  'fleckens.hu',
  'gustr.com',
  'jourrapide.com',
  'rhyta.com',
  'superrito.com',
  'teleworm.us',
  'discard.email',
  'spambog.com',
  'trashymail.com'
]);

class DisposableDomainRegistry {
  private customDomains: Set<string> = new Set();

  public isDisposable(domain: string): boolean {
    if (!domain) return false;
    const cleanDomain = domain.toLowerCase().trim();
    if (DEFAULT_DISPOSABLE_DOMAINS.has(cleanDomain) || this.customDomains.has(cleanDomain)) {
      return true;
    }

    // Check subdomains (e.g. sub.mailinator.com)
    for (const d of DEFAULT_DISPOSABLE_DOMAINS) {
      if (cleanDomain.endsWith(`.${d}`)) {
        return true;
      }
    }
    for (const d of this.customDomains) {
      if (cleanDomain.endsWith(`.${d}`)) {
        return true;
      }
    }

    return false;
  }

  public addDisposableDomain(domain: string): void {
    if (domain) {
      this.customDomains.add(domain.toLowerCase().trim());
    }
  }

  public removeDisposableDomain(domain: string): void {
    if (domain) {
      this.customDomains.delete(domain.toLowerCase().trim());
    }
  }

  public getCount(): number {
    return DEFAULT_DISPOSABLE_DOMAINS.size + this.customDomains.size;
  }
}

export const disposableRegistry = new DisposableDomainRegistry();

export function isDisposableEmail(domain: string): boolean {
  return disposableRegistry.isDisposable(domain);
}
