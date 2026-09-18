/**
 * Single Email Deep Diagnostic Service for ListGuard
 * Returns granular protocol-level diagnostic traces for debugging and inspection.
 * NEVER executes SMTP DATA.
 * NEVER exposes secrets or credentials.
 */

import { PrismaClient } from '@prisma/client';
import net from 'net';
import dns from 'dns';
import { normalizeEmail } from './emailNormalizer';
import { checkEmailSyntax } from './syntaxChecker';
import { checkDomainDns } from './dnsChecker';
import { isDisposableEmail } from './disposableChecker';
import { isRoleAccount } from './roleChecker';
import { isPrivateOrLoopbackIp } from './smtpVerifier';
import { ProviderRules } from './providerRules';

export interface DiagnosticReport {
  email: string;
  normalizedEmail: string;
  syntax: {
    valid: boolean;
    reason?: string | undefined;
  };
  domain: {
    domain: string;
    status: string;
    mxFound: boolean;
    mxHosts: string[];
    error?: string | undefined;
  };
  smtp: {
    tcp: 'CONNECTED' | 'FAILED' | 'SKIPPED';
    targetMx?: string | undefined;
    greeting?: string | undefined;
    ehlo?: string | undefined;
    mailFrom?: string | undefined;
    rcptTo?: string | undefined;
    error?: string | undefined;
  };
  catchAll: {
    tested: boolean;
    isCatchAll: boolean;
  };
  disposable: boolean;
  role: boolean;
  suppression: {
    suppressed: boolean;
    reason?: string | undefined;
  };
  bounce: {
    historicalBounce: boolean;
    bounceType?: string | undefined;
  };
  result: 'DELIVERABLE' | 'UNDELIVERABLE' | 'CATCH_ALL' | 'UNKNOWN';
  verificationReason: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  verifierVersion: string;
  timings: {
    syntaxMs: number;
    dnsMs: number;
    smtpMs: number;
    totalMs: number;
  };
}

export class DiagnosticService {
  public static async runDiagnostics(
    prisma: PrismaClient,
    rawEmail: string,
    userId?: string
  ): Promise<DiagnosticReport> {
    const totalStart = Date.now();
    const verifierVersion = '1.0.0';

    // 1. Normalization
    const norm = normalizeEmail(rawEmail);
    const { normalizedEmail, localPart, domain } = norm;

    // 2. Syntax Timing
    const syntaxStart = Date.now();
    const syntaxCheck = checkEmailSyntax(normalizedEmail);
    const syntaxMs = Date.now() - syntaxStart;

    // 3. Disposable & Role
    const isDisposable = isDisposableEmail(domain);
    const isRole = isRoleAccount(localPart);

    // 4. Suppression & Bounce
    let isSuppressed = false;
    let suppressionReason: string | undefined;
    try {
      const suppressionWhere: any = { normalizedEmail };
      if (userId) {
        suppressionWhere.OR = [{ userId }, { userId: null }];
      }
      const entry = await prisma.suppressionList.findFirst({ where: suppressionWhere });
      if (entry) {
        isSuppressed = true;
        suppressionReason = entry.reason || 'SUPPRESSED';
      }
    } catch {}

    let historicalBounce = false;
    let bounceType: string | undefined;
    try {
      const contactEmail = await prisma.contactEmail.findFirst({
        where: { email: normalizedEmail, verificationStatus: 'bounced' }
      });
      if (contactEmail) {
        historicalBounce = true;
        bounceType = 'HARD_BOUNCE';
      }
    } catch {}

    // Early exit if syntax failed
    if (!syntaxCheck.isValid) {
      const totalMs = Date.now() - totalStart;
      return {
        email: rawEmail,
        normalizedEmail,
        syntax: { valid: false, reason: syntaxCheck.reason },
        domain: { domain, status: 'FAIL', mxFound: false, mxHosts: [] },
        smtp: { tcp: 'SKIPPED' },
        catchAll: { tested: false, isCatchAll: false },
        disposable: isDisposable,
        role: isRole,
        suppression: { suppressed: isSuppressed, reason: suppressionReason },
        bounce: { historicalBounce, bounceType },
        result: 'UNDELIVERABLE',
        verificationReason: 'INVALID_SYNTAX',
        confidence: 'HIGH',
        verifierVersion,
        timings: { syntaxMs, dnsMs: 0, smtpMs: 0, totalMs }
      };
    }

    // 5. DNS / MX Timing
    const dnsStart = Date.now();
    const dnsResult = await checkDomainDns(domain);
    const dnsMs = Date.now() - dnsStart;

    if (dnsResult.domainStatus === 'FAIL' || dnsResult.mxStatus === 'FAIL' || dnsResult.mxHosts.length === 0) {
      const totalMs = Date.now() - totalStart;
      return {
        email: rawEmail,
        normalizedEmail,
        syntax: { valid: true },
        domain: {
          domain,
          status: dnsResult.domainStatus,
          mxFound: false,
          mxHosts: [],
          error: dnsResult.errorMessage || 'No MX records found'
        },
        smtp: { tcp: 'SKIPPED' },
        catchAll: { tested: false, isCatchAll: false },
        disposable: isDisposable,
        role: isRole,
        suppression: { suppressed: isSuppressed, reason: suppressionReason },
        bounce: { historicalBounce, bounceType },
        result: 'UNDELIVERABLE',
        verificationReason: 'NO_MX',
        confidence: 'HIGH',
        verifierVersion,
        timings: { syntaxMs, dnsMs, smtpMs: 0, totalMs }
      };
    }

    // 6. SMTP Handshake Trace
    const smtpStart = Date.now();
    const targetMx = dnsResult.mxHosts[0]!;
    const heloDomain = process.env.LISTGUARD_HELO_DOMAIN || 'verify.tripgain.com';
    const fromEmail = process.env.LISTGUARD_FROM_EMAIL || 'verify@tripgain.com';

    let tcpStatus: 'CONNECTED' | 'FAILED' | 'SKIPPED' = 'SKIPPED';
    let greeting: string | undefined;
    let ehlo: string | undefined;
    let mailFrom: string | undefined;
    let rcptTo: string | undefined;
    let smtpError: string | undefined;
    let isCatchAll = false;
    let catchAllTested = false;

    // Execute diagnostic trace
    try {
      const trace = await new Promise<{
        greeting: string;
        ehlo: string;
        mailFrom: string;
        rcptTo: string;
        rcptCode: number;
      }>((resolve, reject) => {
        dns.lookup(targetMx, (lookupErr, ip) => {
          if (lookupErr) return reject(new Error(`DNS resolution failed for ${targetMx}`));
          if (isPrivateOrLoopbackIp(ip)) {
            return reject(new Error(`Security violation: ${targetMx} resolved to private IP ${ip}`));
          }

          const socket = new net.Socket();
          let buffer = '';
          let phase: 'BANNER' | 'EHLO' | 'MAIL_FROM' | 'RCPT_TO' | 'DONE' = 'BANNER';
          let g = '';
          let e = '';
          let m = '';
          let r = '';
          let rCode = 0;

          socket.setTimeout(8000);
          socket.on('timeout', () => {
            socket.destroy();
            reject(new Error('SMTP connection timed out after 8000ms'));
          });
          socket.on('error', (err) => {
            reject(err);
          });

          socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\r\n').filter(Boolean);
            const last = lines[lines.length - 1];
            if (!last || !/^\d{3}\s/.test(last)) return;

            const code = parseInt(last.substring(0, 3), 10);
            buffer = '';

            switch (phase) {
              case 'BANNER':
                g = last;
                tcpStatus = 'CONNECTED';
                if (code >= 200 && code < 300) {
                  phase = 'EHLO';
                  socket.write(`EHLO ${heloDomain}\r\n`);
                } else {
                  socket.write('QUIT\r\n');
                  resolve({ greeting: g, ehlo: e, mailFrom: m, rcptTo: last, rcptCode: code });
                }
                break;
              case 'EHLO':
                e = last;
                if (code >= 200 && code < 300) {
                  phase = 'MAIL_FROM';
                  socket.write(`MAIL FROM:<${fromEmail}>\r\n`);
                } else {
                  // Fallback HELO
                  phase = 'MAIL_FROM';
                  socket.write(`HELO ${heloDomain}\r\n`);
                }
                break;
              case 'MAIL_FROM':
                m = last;
                if (code >= 200 && code < 300) {
                  phase = 'RCPT_TO';
                  socket.write(`RCPT TO:<${normalizedEmail}>\r\n`);
                } else {
                  socket.write('QUIT\r\n');
                  resolve({ greeting: g, ehlo: e, mailFrom: m, rcptTo: last, rcptCode: code });
                }
                break;
              case 'RCPT_TO':
                r = last;
                rCode = code;
                phase = 'DONE';
                try {
                  socket.write('QUIT\r\n');
                } catch {}
                socket.destroy();
                resolve({ greeting: g, ehlo: e, mailFrom: m, rcptTo: r, rcptCode: rCode });
                break;
            }
          });

          socket.connect(25, ip);
        });
      });

      greeting = trace.greeting;
      ehlo = trace.ehlo;
      mailFrom = trace.mailFrom;
      rcptTo = trace.rcptTo;
      tcpStatus = 'CONNECTED';

      // Interpret response
      const interp = ProviderRules.interpretResponse({
        code: trace.rcptCode,
        response: trace.rcptTo,
        mxHosts: dnsResult.mxHosts
      });

      const smtpMs = Date.now() - smtpStart;
      const totalMs = Date.now() - totalStart;

      let result: 'DELIVERABLE' | 'UNDELIVERABLE' | 'CATCH_ALL' | 'UNKNOWN' = 'UNKNOWN';
      if (interp.status === 'DELIVERABLE_SIGNAL') {
        result = isRole ? 'DELIVERABLE' : 'DELIVERABLE';
      } else if (interp.status === 'UNDELIVERABLE_SIGNAL') {
        result = 'UNDELIVERABLE';
      }

      return {
        email: rawEmail,
        normalizedEmail,
        syntax: { valid: true },
        domain: {
          domain,
          status: dnsResult.domainStatus,
          mxFound: true,
          mxHosts: dnsResult.mxHosts
        },
        smtp: {
          tcp: tcpStatus,
          targetMx,
          greeting,
          ehlo,
          mailFrom,
          rcptTo
        },
        catchAll: { tested: catchAllTested, isCatchAll },
        disposable: isDisposable,
        role: isRole,
        suppression: { suppressed: isSuppressed, reason: suppressionReason },
        bounce: { historicalBounce, bounceType },
        result,
        verificationReason: interp.reason,
        confidence: interp.confidence,
        verifierVersion,
        timings: { syntaxMs, dnsMs, smtpMs, totalMs }
      };
    } catch (err: any) {
      smtpError = err?.message || 'SMTP handshake failed';
      tcpStatus = 'FAILED';
      const smtpMs = Date.now() - smtpStart;
      const totalMs = Date.now() - totalStart;
      const isTimeout = /timeout|timed out/i.test(smtpError || '');

      return {
        email: rawEmail,
        normalizedEmail,
        syntax: { valid: true },
        domain: {
          domain,
          status: dnsResult.domainStatus,
          mxFound: true,
          mxHosts: dnsResult.mxHosts
        },
        smtp: {
          tcp: tcpStatus,
          targetMx,
          error: smtpError
        },
        catchAll: { tested: false, isCatchAll: false },
        disposable: isDisposable,
        role: isRole,
        suppression: { suppressed: isSuppressed, reason: suppressionReason },
        bounce: { historicalBounce, bounceType },
        result: 'UNKNOWN',
        verificationReason: isTimeout ? 'SMTP_TIMEOUT' : 'SMTP_BLOCKED',
        confidence: 'LOW',
        verifierVersion,
        timings: { syntaxMs, dnsMs, smtpMs, totalMs }
      };
    }
  }
}
