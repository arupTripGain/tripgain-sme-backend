/**
 * RateLimiter for ListGuard Email Verification
 * Manages concurrency limits:
 * - Global concurrency (default: 6)
 * - Per-domain concurrency (default: 2)
 */

export interface RateLimiterOptions {
  maxGlobalConcurrency?: number;
  maxPerDomainConcurrency?: number;
}

export class RateLimiter {
  private activeGlobalCount: number = 0;
  private activeDomainCounts: Map<string, number> = new Map();
  private maxGlobal: number;
  private maxPerDomain: number;

  constructor(options?: RateLimiterOptions) {
    const envGlobal = process.env.LISTGUARD_MAX_CONCURRENCY;
    const envPerDomain = process.env.LISTGUARD_PER_DOMAIN_CONCURRENCY;

    this.maxGlobal = options?.maxGlobalConcurrency ?? (envGlobal ? parseInt(envGlobal, 10) : 6);
    this.maxPerDomain = options?.maxPerDomainConcurrency ?? (envPerDomain ? parseInt(envPerDomain, 10) : 2);
  }

  /**
   * Checks if an operation can proceed for a given domain under current concurrency limits.
   */
  public canAcquire(domain: string): boolean {
    const normalizedDomain = (domain || '').toLowerCase().trim();
    if (this.activeGlobalCount >= this.maxGlobal) {
      return false;
    }
    const currentDomainCount = this.activeDomainCounts.get(normalizedDomain) || 0;
    return currentDomainCount < this.maxPerDomain;
  }

  /**
   * Attempts to acquire a concurrency slot for a given domain.
   * Returns true if slot was acquired, false otherwise.
   */
  public acquire(domain: string): boolean {
    const normalizedDomain = (domain || '').toLowerCase().trim();
    if (!this.canAcquire(normalizedDomain)) {
      return false;
    }

    this.activeGlobalCount++;
    const current = this.activeDomainCounts.get(normalizedDomain) || 0;
    this.activeDomainCounts.set(normalizedDomain, current + 1);
    return true;
  }

  /**
   * Releases an acquired concurrency slot for a domain.
   */
  public release(domain: string): void {
    const normalizedDomain = (domain || '').toLowerCase().trim();
    if (this.activeGlobalCount > 0) {
      this.activeGlobalCount--;
    }

    const current = this.activeDomainCounts.get(normalizedDomain) || 0;
    if (current <= 1) {
      this.activeDomainCounts.delete(normalizedDomain);
    } else {
      this.activeDomainCounts.set(normalizedDomain, current - 1);
    }
  }

  /**
   * Waits until a concurrency slot becomes available for a domain, then acquires it.
   */
  public async waitForSlot(domain: string, timeoutMs: number = 30000): Promise<boolean> {
    const normalizedDomain = (domain || '').toLowerCase().trim();
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (this.acquire(normalizedDomain)) {
        return true;
      }
      await new Promise(r => setTimeout(r, 50));
    }

    return false;
  }

  public getStats(): {
    globalActive: number;
    maxGlobal: number;
    domainCounts: Record<string, number>;
    maxPerDomain: number;
  } {
    const domainCounts: Record<string, number> = {};
    for (const [d, count] of this.activeDomainCounts.entries()) {
      domainCounts[d] = count;
    }
    return {
      globalActive: this.activeGlobalCount,
      maxGlobal: this.maxGlobal,
      domainCounts,
      maxPerDomain: this.maxPerDomain
    };
  }

  public reset(): void {
    this.activeGlobalCount = 0;
    this.activeDomainCounts.clear();
  }
}

export const globalRateLimiter = new RateLimiter();
