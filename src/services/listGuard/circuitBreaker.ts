/**
 * Per-Domain Circuit Breaker for ListGuard Email Verification
 * States:
 * - CLOSED: Normal operation; handshakes are permitted.
 * - OPEN: Domain has repeatedly failed with network/timeout/block errors;
 *         further queries to this domain short-circuit to UNKNOWN immediately
 *         without hammering the destination mail servers.
 * - HALF_OPEN: Cooldown period has elapsed; one trial probe is allowed to test recovery.
 *
 * CRITICAL SAFETY RULE:
 * Normal 550 invalid-mailbox responses MUST NOT trip the circuit breaker.
 * Only connection timeouts, connection refused, network resets, and IP gateway blocks trip it.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number; // Consecutive failures before tripping to OPEN (default: 3)
  cooldownMs?: number;       // Time in ms before moving from OPEN to HALF_OPEN (default: 60s)
}

interface DomainCircuitRecord {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastStateChangeAt: number;
}

export class DomainCircuitBreaker {
  private circuits: Map<string, DomainCircuitRecord> = new Map();
  private failureThreshold: number;
  private cooldownMs: number;

  constructor(options?: CircuitBreakerOptions) {
    this.failureThreshold = options?.failureThreshold ?? 3;
    this.cooldownMs = options?.cooldownMs ?? 60000; // 60 seconds
  }

  /**
   * Checks whether a verification probe to the target domain is permitted.
   */
  public canAttempt(domain: string): { allowed: boolean; state: CircuitState; reason?: string } {
    const normalizedDomain = (domain || '').toLowerCase().trim();
    if (!normalizedDomain) {
      return { allowed: true, state: 'CLOSED' };
    }

    const record = this.circuits.get(normalizedDomain);
    if (!record || record.state === 'CLOSED') {
      return { allowed: true, state: 'CLOSED' };
    }

    const now = Date.now();

    if (record.state === 'OPEN') {
      if (now - record.lastStateChangeAt >= this.cooldownMs) {
        // Cooldown passed: transition to HALF_OPEN to test 1 candidate
        record.state = 'HALF_OPEN';
        record.lastStateChangeAt = now;
        return { allowed: true, state: 'HALF_OPEN' };
      }
      return {
        allowed: false,
        state: 'OPEN',
        reason: `Circuit breaker OPEN for ${normalizedDomain}: destination host repeatedly timed out or blocked connections`
      };
    }

    // HALF_OPEN: only one trial probe is typically in flight
    return { allowed: true, state: 'HALF_OPEN' };
  }

  /**
   * Records a successful communication or valid protocol response (including 250, 550 user unknown, etc.)
   */
  public recordSuccess(domain: string): void {
    const normalizedDomain = (domain || '').toLowerCase().trim();
    if (!normalizedDomain) return;

    const record = this.circuits.get(normalizedDomain);
    if (record) {
      record.state = 'CLOSED';
      record.consecutiveFailures = 0;
      record.lastFailureAt = null;
      record.lastStateChangeAt = Date.now();
    }
  }

  /**
   * Records a communication failure.
   * ONLY network, timeout, refused, reset, or gateway blocks trigger failures.
   */
  public recordFailure(domain: string, isNetworkOrGatewayFailure: boolean): void {
    if (!isNetworkOrGatewayFailure) {
      return; // Do not trip for regular mailbox rejections (e.g. 550 5.1.1)
    }

    const normalizedDomain = (domain || '').toLowerCase().trim();
    if (!normalizedDomain) return;

    const now = Date.now();
    let record = this.circuits.get(normalizedDomain);

    if (!record) {
      record = {
        state: 'CLOSED',
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastStateChangeAt: now
      };
      this.circuits.set(normalizedDomain, record);
    }

    record.consecutiveFailures++;
    record.lastFailureAt = now;

    if (record.state === 'HALF_OPEN') {
      // Failed during recovery probe; trip back to OPEN immediately
      record.state = 'OPEN';
      record.lastStateChangeAt = now;
    } else if (record.state === 'CLOSED' && record.consecutiveFailures >= this.failureThreshold) {
      // Tripped to OPEN
      record.state = 'OPEN';
      record.lastStateChangeAt = now;
    }
  }

  public getState(domain: string): {
    state: CircuitState;
    consecutiveFailures: number;
    lastFailureAt: Date | null;
  } {
    const normalizedDomain = (domain || '').toLowerCase().trim();
    const record = this.circuits.get(normalizedDomain);
    if (!record) {
      return { state: 'CLOSED', consecutiveFailures: 0, lastFailureAt: null };
    }
    return {
      state: record.state,
      consecutiveFailures: record.consecutiveFailures,
      lastFailureAt: record.lastFailureAt ? new Date(record.lastFailureAt) : null
    };
  }

  public reset(domain?: string): void {
    if (domain) {
      this.circuits.delete(domain.toLowerCase().trim());
    } else {
      this.circuits.clear();
    }
  }
}

export const globalCircuitBreaker = new DomainCircuitBreaker();
