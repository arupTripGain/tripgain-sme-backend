import net from 'net';
import dns from 'dns';
import crypto from 'crypto';
import { ProviderRules, VerificationConfidence } from './providerRules';
import { globalCircuitBreaker } from './circuitBreaker';

export type SmtpSignalStatus =
  | 'DELIVERABLE_SIGNAL'
  | 'UNDELIVERABLE_SIGNAL'
  | 'TEMPORARY_FAILURE'
  | 'GREYLISTED'
  | 'CATCH_ALL'
  | 'UNKNOWN';

export type VerificationReason =
  | 'VALID_MAILBOX'
  | 'INVALID_MAILBOX'
  | 'NO_MX'
  | 'INVALID_SYNTAX'
  | 'CATCH_ALL_DOMAIN'
  | 'DISPOSABLE_DOMAIN'
  | 'ROLE_ADDRESS'
  | 'SUPPRESSED'
  | 'HARD_BOUNCED'
  | 'GREYLISTED'
  | 'SMTP_TIMEOUT'
  | 'SMTP_BLOCKED'
  | 'UNKNOWN';

export interface SmtpVerifyResult {
  smtpStatus: SmtpSignalStatus;
  isCatchAll: boolean;
  verificationReason?: VerificationReason | undefined;
  confidence?: VerificationConfidence | undefined;
  smtpResponseCode?: string | undefined;
  smtpResponse?: string | undefined;
  attempts: number;
}

export interface SmtpVerifierOptions {
  heloDomain?: string;
  fromEmail?: string;
  timeoutMs?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
}

const DEFAULT_OPTIONS: Required<SmtpVerifierOptions> = {
  heloDomain: process.env.LISTGUARD_HELO_DOMAIN || 'verify.tripgain.com',
  fromEmail: process.env.LISTGUARD_FROM_EMAIL || 'verify@tripgain.com',
  timeoutMs: 6000,
  maxRetries: 1, // Bounded retries: attempt 1 + 1 retry = max 2 attempts
  initialBackoffMs: 1000
};

// Cache for catch-all domain test results (domain -> { isCatchAll: boolean, expiresAt: number })
const domainCatchAllCache = new Map<string, { isCatchAll: boolean; expiresAt: number }>();
const CATCH_ALL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Test hook for mocking raw SMTP responses in unit tests without hitting real mail servers
type SmtpMockHandler = (email: string, domain: string, mxHost: string) => Promise<SmtpVerifyResult | null>;
let testMockHandler: SmtpMockHandler | null = null;

export function setTestSmtpMockHandler(handler: SmtpMockHandler | null): void {
  testMockHandler = handler;
}

/**
 * Classifies an SMTP response code and text conservatively.
 * Preserved for backwards compatibility with engine tests.
 */
export function classifySmtpHandshakeResponse(
  code: number,
  response: string
): {
  status: 'DELIVERABLE_SIGNAL' | 'UNDELIVERABLE_SIGNAL' | 'GREYLISTED' | 'UNKNOWN';
  reason: VerificationReason;
} {
  const interp = ProviderRules.interpretResponse({
    code,
    response,
    mxHosts: []
  });
  return {
    status: interp.status as any,
    reason: interp.reason
  };
}

/**
 * Validates whether an IP address belongs to a private, loopback, or link-local range.
 * Protects against SSRF vulnerabilities.
 */
export function isPrivateOrLoopbackIp(ip: string): boolean {
  if (!ip) return true;
  const trimmed = ip.trim();

  // IPv4 check
  if (net.isIPv4(trimmed)) {
    const parts = trimmed.split('.').map(p => parseInt(p, 10));
    if (parts.length !== 4) return true;
    if (parts[0] === 127) return true; // Loopback
    if (parts[0] === 10) return true;  // 10.0.0.0/8
    if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.0.0/16
    if (parts[0] === 0) return true;   // 0.0.0.0/8
    return false;
  }

  // IPv6 check
  if (net.isIPv6(trimmed)) {
    const lower = trimmed.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:')) return true; // Link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // Unique local
    return false;
  }

  return false;
}

/**
 * Performs a single low-level SMTP recipient handshake against a mail host:
 * Connect -> Read banner -> EHLO/HELO -> MAIL FROM -> RCPT TO -> QUIT
 * CRITICAL RULE: NEVER sends DATA or message body.
 */
function rawSmtpHandshake(
  mxHost: string,
  targetEmail: string,
  options: Required<SmtpVerifierOptions>
): Promise<{ code: number; response: string }> {
  return new Promise((resolve, reject) => {
    // 1. SSRF Safety Check: Verify host does not resolve to private IP
    dns.lookup(mxHost, (lookupErr, resolvedIp) => {
      if (lookupErr) {
        return reject(new Error(`DNS resolution failed for MX host ${mxHost}: ${lookupErr.message}`));
      }

      if (isPrivateOrLoopbackIp(resolvedIp)) {
        return reject(new Error(`Security block: MX host ${mxHost} resolved to private/loopback IP ${resolvedIp}`));
      }

      const socket = new net.Socket();
      let responseData = '';
      let step: 'BANNER' | 'HELO' | 'MAIL_FROM' | 'RCPT_TO' | 'QUIT' = 'BANNER';
      let settled = false;

      const cleanup = () => {
        socket.removeAllListeners();
        if (!socket.destroyed) {
          socket.destroy();
        }
      };

      const finish = (result: { code: number; response: string }) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(result);
        }
      };

      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      };

      socket.setTimeout(options.timeoutMs);

      socket.on('timeout', () => {
        fail(new Error('SMTP socket timeout'));
      });

      socket.on('error', (err) => {
        fail(err);
      });

      socket.on('data', (chunk) => {
        responseData += chunk.toString('utf8');
        const lines = responseData.split('\r\n').filter(Boolean);
        const lastLine = lines[lines.length - 1];

        // Standard SMTP line: "250 ..." (multiline continuation lines have a dash "250-...")
        if (!lastLine || !/^\d{3}\s/.test(lastLine)) {
          return;
        }

        const statusCode = parseInt(lastLine.substring(0, 3), 10);
        responseData = ''; // Reset buffer for next command

        switch (step) {
          case 'BANNER':
            if (statusCode >= 200 && statusCode < 300) {
              step = 'HELO';
              socket.write(`EHLO ${options.heloDomain}\r\n`);
            } else {
              finish({ code: statusCode, response: lastLine });
            }
            break;

          case 'HELO':
            if (statusCode >= 200 && statusCode < 300) {
              step = 'MAIL_FROM';
              socket.write(`MAIL FROM:<${options.fromEmail}>\r\n`);
            } else {
              // If EHLO fails, fallback to simple HELO once
              step = 'MAIL_FROM';
              socket.write(`HELO ${options.heloDomain}\r\n`);
            }
            break;

          case 'MAIL_FROM':
            if (statusCode >= 200 && statusCode < 300) {
              step = 'RCPT_TO';
              socket.write(`RCPT TO:<${targetEmail}>\r\n`);
            } else {
              finish({ code: statusCode, response: lastLine });
            }
            break;

          case 'RCPT_TO':
            // Recipient acceptance response received
            step = 'QUIT';
            try {
              socket.write('QUIT\r\n');
            } catch {}
            finish({ code: statusCode, response: lastLine });
            break;

          case 'QUIT':
            finish({ code: statusCode, response: lastLine });
            break;
        }
      });

      // Connect to port 25 (standard MTA SMTP port)
      socket.connect(25, resolvedIp);
    });
  });
}

/**
 * Tests whether a domain is configured as a catch-all mailbox
 * by probing a randomly generated non-existent address.
 * Maximum 1 probe per domain per job; results cached for 7 days.
 */
async function probeCatchAll(
  domain: string,
  mxHost: string,
  options: Required<SmtpVerifierOptions>
): Promise<boolean> {
  const cached = domainCatchAllCache.get(domain);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.isCatchAll;
  }

  const randomPart = `listguard_probe_${crypto.randomBytes(6).toString('hex')}`;
  const probeEmail = `${randomPart}@${domain}`;

  try {
    const res = await rawSmtpHandshake(mxHost, probeEmail, options);
    // If server accepts an arbitrary random probe email with 250, it is a catch-all
    const isCatchAll = res.code >= 200 && res.code < 300;
    domainCatchAllCache.set(domain, {
      isCatchAll,
      expiresAt: Date.now() + CATCH_ALL_CACHE_TTL_MS
    });
    return isCatchAll;
  } catch {
    // If probe fails or times out, do not assume catch-all
    return false;
  }
}

/**
 * Verifies an email recipient via controlled SMTP handshakes.
 * Includes circuit breaker check, bounded retries, provider rules, and catch-all detection.
 */
export async function verifyEmailSmtp(
  email: string,
  domain: string,
  mxHosts: string[],
  userOptions?: SmtpVerifierOptions
): Promise<SmtpVerifyResult> {
  const opts: Required<SmtpVerifierOptions> = {
    ...DEFAULT_OPTIONS,
    ...userOptions
  };

  // 1. Check if unit test mock handler is set
  if (testMockHandler) {
    const mockResult = await testMockHandler(email, domain, mxHosts[0] || 'localhost');
    if (mockResult) {
      return mockResult;
    }
  }

  // 2. Architectural Guard: Vercel API must never directly execute SMTP verification
  // Only the dedicated worker process or local test environments may invoke direct SMTP
  const isDedicatedWorker = process.env.LISTGUARD_WORKER === 'true';
  const isLocalOrTest = process.env.NODE_ENV !== 'production' || process.env.TS_NODE_DEV !== undefined;

  if (process.env.VERCEL || (!isDedicatedWorker && !isLocalOrTest)) {
    return {
      smtpStatus: 'UNKNOWN',
      isCatchAll: false,
      verificationReason: 'SMTP_BLOCKED',
      confidence: 'LOW',
      smtpResponseCode: undefined,
      smtpResponse: 'Direct SMTP verification is restricted to the dedicated ListGuard worker process with open outbound port 25.',
      attempts: 0
    };
  }

  if (!mxHosts || mxHosts.length === 0) {
    return {
      smtpStatus: 'UNKNOWN',
      isCatchAll: false,
      confidence: 'LOW',
      smtpResponseCode: undefined,
      smtpResponse: 'No MX hosts available for SMTP verification',
      attempts: 0
    };
  }

  // 3. Circuit Breaker Check
  const circuit = globalCircuitBreaker.canAttempt(domain);
  if (!circuit.allowed) {
    return {
      smtpStatus: 'UNKNOWN',
      isCatchAll: false,
      verificationReason: 'SMTP_BLOCKED',
      confidence: 'LOW',
      smtpResponseCode: undefined,
      smtpResponse: circuit.reason || `Circuit breaker OPEN for domain ${domain}`,
      attempts: 0
    };
  }

  const primaryMx = mxHosts[0]!;
  let attempts = 0;
  let lastCode: number | undefined;
  let lastResponse: string | undefined;

  // Bounded retry loop: retries ONLY transient 4xx or connection errors
  while (attempts <= opts.maxRetries) {
    attempts++;
    try {
      const res = await rawSmtpHandshake(primaryMx, email, opts);
      lastCode = res.code;
      lastResponse = res.response;

      // Interpret using provider-specific intelligence rules
      const interpretation = ProviderRules.interpretResponse({
        code: res.code,
        response: res.response,
        mxHosts
      });

      // Record success in circuit breaker
      globalCircuitBreaker.recordSuccess(domain);

      if (interpretation.reason === 'SMTP_BLOCKED') {
        globalCircuitBreaker.recordFailure(domain, true);
        return {
          smtpStatus: 'UNKNOWN',
          isCatchAll: false,
          verificationReason: 'SMTP_BLOCKED',
          confidence: interpretation.confidence,
          smtpResponseCode: String(res.code),
          smtpResponse: `SMTP transaction blocked by gateway or IP reputation: ${res.response}`,
          attempts
        };
      }

      if (interpretation.status === 'DELIVERABLE_SIGNAL') {
        // Test for catch-all domain
        const isCatchAll = await probeCatchAll(domain, primaryMx, opts);
        if (isCatchAll) {
          return {
            smtpStatus: 'CATCH_ALL',
            isCatchAll: true,
            verificationReason: 'CATCH_ALL_DOMAIN',
            confidence: 'HIGH',
            smtpResponseCode: String(res.code),
            smtpResponse: res.response,
            attempts
          };
        }
        return {
          smtpStatus: 'DELIVERABLE_SIGNAL',
          isCatchAll: false,
          verificationReason: 'VALID_MAILBOX',
          confidence: interpretation.confidence,
          smtpResponseCode: String(res.code),
          smtpResponse: res.response,
          attempts
        };
      }

      if (interpretation.status === 'UNDELIVERABLE_SIGNAL') {
        return {
          smtpStatus: 'UNDELIVERABLE_SIGNAL',
          isCatchAll: false,
          verificationReason: 'INVALID_MAILBOX',
          confidence: interpretation.confidence,
          smtpResponseCode: String(res.code),
          smtpResponse: res.response,
          attempts
        };
      }

      if (interpretation.status === 'GREYLISTED') {
        if (attempts <= opts.maxRetries) {
          // Bounded exponential backoff delay with jitter
          const jitter = Math.floor(Math.random() * 500);
          const delay = opts.initialBackoffMs * Math.pow(1.5, attempts - 1) + jitter;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        } else {
          // Retries exhausted: conservative fallback to UNKNOWN / GREYLISTED
          return {
            smtpStatus: 'GREYLISTED',
            isCatchAll: false,
            verificationReason: 'GREYLISTED',
            confidence: interpretation.confidence,
            smtpResponseCode: String(res.code),
            smtpResponse: `Greylisted/Temporary response after ${attempts} attempts: ${res.response}`,
            attempts
          };
        }
      }

      return {
        smtpStatus: 'UNKNOWN',
        isCatchAll: false,
        verificationReason: 'UNKNOWN',
        confidence: 'LOW',
        smtpResponseCode: String(res.code),
        smtpResponse: res.response,
        attempts
      };
    } catch (err: any) {
      const errMsg = String(err?.message || '');
      lastResponse = errMsg || 'SMTP connection error';
      const isTimeout = /timeout|timed out/i.test(errMsg);

      // Record network/timeout failure in circuit breaker
      globalCircuitBreaker.recordFailure(domain, true);

      if (attempts <= opts.maxRetries) {
        const jitter = Math.floor(Math.random() * 400);
        const delay = opts.initialBackoffMs * attempts + jitter;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      return {
        smtpStatus: 'UNKNOWN',
        isCatchAll: false,
        verificationReason: isTimeout ? 'SMTP_TIMEOUT' : 'SMTP_BLOCKED',
        confidence: 'LOW',
        smtpResponseCode: lastCode ? String(lastCode) : undefined,
        smtpResponse: lastResponse,
        attempts
      };
    }
  }

  // If retries exhausted without definite response: return UNKNOWN
  return {
    smtpStatus: 'UNKNOWN',
    isCatchAll: false,
    verificationReason: 'SMTP_TIMEOUT',
    confidence: 'LOW',
    smtpResponseCode: lastCode ? String(lastCode) : undefined,
    smtpResponse: lastResponse || 'SMTP connection timed out or unreachable',
    attempts
  };
}
