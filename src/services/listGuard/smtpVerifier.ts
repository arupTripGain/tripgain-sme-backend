import net from 'net';
import crypto from 'crypto';

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
  maxRetries: 2, // Bounded retries: attempt 1 + up to 2 retries = max 3 attempts
  initialBackoffMs: 800
};

// Cache for catch-all domain test results (domain -> { isCatchAll: boolean, timestamp: number })
const domainCatchAllCache = new Map<string, { isCatchAll: boolean; expiresAt: number }>();
const CATCH_ALL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Test hook for mocking raw SMTP responses in unit tests without hitting real mail servers
type SmtpMockHandler = (email: string, domain: string, mxHost: string) => Promise<SmtpVerifyResult | null>;
let testMockHandler: SmtpMockHandler | null = null;

export function setTestSmtpMockHandler(handler: SmtpMockHandler | null): void {
  testMockHandler = handler;
}

/**
 * Performs a single low-level SMTP recipient handshake against a mail host:
 * Connect -> Read banner -> EHLO/HELO -> MAIL FROM -> RCPT TO -> QUIT
 * NEVER sends DATA or message body.
 */
function rawSmtpHandshake(
  mxHost: string,
  targetEmail: string,
  options: Required<SmtpVerifierOptions>
): Promise<{ code: number; response: string }> {
  return new Promise((resolve, reject) => {
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

      // Standard SMTP line: "250 ..." (multiline lines have a dash "250-...")
      if (!lastLine || !/^\d{3}\s/.test(lastLine)) {
        return;
      }

      const statusCode = parseInt(lastLine.substring(0, 3), 10);
      responseData = ''; // Reset buffer for next step

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
          // We got our recipient acceptance response!
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
    socket.connect(25, mxHost);
  });
}

/**
 * Tests whether a domain is configured as a catch-all mailbox
 * by probing a randomly generated non-existent address.
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
    // If the server accepts an arbitrary random probe email with 250, it is a catch-all!
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
 * Classifies an SMTP response code and text conservatively.
 * Crucial rule: Ambiguous responses, security gateways, and IP blocks NEVER become DELIVERABLE.
 */
export function classifySmtpHandshakeResponse(
  code: number,
  response: string
): {
  status: 'DELIVERABLE_SIGNAL' | 'UNDELIVERABLE_SIGNAL' | 'GREYLISTED' | 'UNKNOWN';
  reason: VerificationReason;
} {
  const responseText = (response || '').toLowerCase();
  const isSecurityOrIpBlock =
    /blocked|blacklisted|blacklist|spamhaus|barracuda|proofpoint|mimecast|reputation|relay denied|relay access denied|administrative prohibition|policy rejection|5\.7\.1|dnsbl|rbl|service unavailable/i.test(
      responseText
    ) || code === 554;

  if (isSecurityOrIpBlock) {
    return {
      status: 'UNKNOWN',
      reason: 'SMTP_BLOCKED'
    };
  }

  // Positive response (250 OK)
  if (code >= 200 && code < 300) {
    return {
      status: 'DELIVERABLE_SIGNAL',
      reason: 'VALID_MAILBOX'
    };
  }

  // Permanent failure (550, 551, 552, 553 User unknown / mailbox unavailable)
  if (code >= 500 && code < 600) {
    return {
      status: 'UNDELIVERABLE_SIGNAL',
      reason: 'INVALID_MAILBOX'
    };
  }

  // Temporary failure / Greylisting (450, 451, 452, 421)
  if (code >= 400 && code < 500) {
    return {
      status: 'GREYLISTED',
      reason: 'GREYLISTED'
    };
  }

  return {
    status: 'UNKNOWN',
    reason: 'UNKNOWN'
  };
}

/**
 * Verifies an email recipient via controlled SMTP handshakes.
 * Includes bounded greylisting retries and catch-all detection.
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

  if (!mxHosts || mxHosts.length === 0) {
    return {
      smtpStatus: 'UNKNOWN',
      isCatchAll: false,
      smtpResponseCode: undefined,
      smtpResponse: 'No MX hosts available for SMTP verification',
      attempts: 0
    };
  }

  const primaryMx = mxHosts[0]!;
  let attempts = 0;
  let lastCode: number | undefined;
  let lastResponse: string | undefined;

  // Bounded retry loop for greylisting / temporary 4xx responses
  while (attempts <= opts.maxRetries) {
    attempts++;
    try {
      const res = await rawSmtpHandshake(primaryMx, email, opts);
      lastCode = res.code;
      lastResponse = res.response;

      const classification = classifySmtpHandshakeResponse(res.code, res.response);

      if (classification.reason === 'SMTP_BLOCKED') {
        return {
          smtpStatus: 'UNKNOWN',
          isCatchAll: false,
          verificationReason: 'SMTP_BLOCKED',
          smtpResponseCode: String(res.code),
          smtpResponse: `SMTP transaction blocked by gateway or IP reputation: ${res.response}`,
          attempts
        };
      }

      if (classification.status === 'DELIVERABLE_SIGNAL') {
        // Test for catch-all domain
        const isCatchAll = await probeCatchAll(domain, primaryMx, opts);
        if (isCatchAll) {
          return {
            smtpStatus: 'CATCH_ALL',
            isCatchAll: true,
            verificationReason: 'CATCH_ALL_DOMAIN',
            smtpResponseCode: String(res.code),
            smtpResponse: res.response,
            attempts
          };
        }
        return {
          smtpStatus: 'DELIVERABLE_SIGNAL',
          isCatchAll: false,
          verificationReason: 'VALID_MAILBOX',
          smtpResponseCode: String(res.code),
          smtpResponse: res.response,
          attempts
        };
      }

      if (classification.status === 'UNDELIVERABLE_SIGNAL') {
        return {
          smtpStatus: 'UNDELIVERABLE_SIGNAL',
          isCatchAll: false,
          verificationReason: 'INVALID_MAILBOX',
          smtpResponseCode: String(res.code),
          smtpResponse: res.response,
          attempts
        };
      }

      if (classification.status === 'GREYLISTED') {
        if (attempts <= opts.maxRetries) {
          // Exponential backoff delay before bounded retry
          const delay = opts.initialBackoffMs * Math.pow(1.5, attempts - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        } else {
          // Bounded retries exhausted: return UNKNOWN (never treat temporary as permanent failure)
          return {
            smtpStatus: 'GREYLISTED',
            isCatchAll: false,
            verificationReason: 'GREYLISTED',
            smtpResponseCode: String(res.code),
            smtpResponse: `Greylisted/Temporary failure after ${attempts} attempts: ${res.response}`,
            attempts
          };
        }
      }

      // Any other unexpected response code
      return {
        smtpStatus: 'UNKNOWN',
        isCatchAll: false,
        verificationReason: 'UNKNOWN',
        smtpResponseCode: String(res.code),
        smtpResponse: res.response,
        attempts
      };
    } catch (err: any) {
      // Network timeout, socket error, or ISP blocked port 25
      const errMsg = String(err?.message || '');
      lastResponse = errMsg || 'SMTP connection error';
      const isTimeout = /timeout|timed out/i.test(errMsg);

      if (attempts <= opts.maxRetries) {
        const delay = opts.initialBackoffMs * attempts;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      return {
        smtpStatus: 'UNKNOWN',
        isCatchAll: false,
        verificationReason: isTimeout ? 'SMTP_TIMEOUT' : 'SMTP_BLOCKED',
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
    smtpResponseCode: lastCode ? String(lastCode) : undefined,
    smtpResponse: lastResponse || 'SMTP connection timed out or unreachable',
    attempts
  };
}
