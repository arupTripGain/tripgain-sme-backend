import { PrismaClient } from '@prisma/client';
import { normalizeEmail, NormalizedEmailResult } from './emailNormalizer';
import { checkEmailSyntax, SyntaxCheckResult } from './syntaxChecker';
import { checkDomainDns, DnsCheckResult } from './dnsChecker';
import { isDisposableEmail } from './disposableChecker';
import { isRoleAccount } from './roleChecker';
import {
  verifyEmailSmtp,
  SmtpVerifyResult,
  SmtpVerifierOptions,
  VerificationReason
} from './smtpVerifier';
import { VerificationConfidence } from './providerRules';
import { ListGuardStore } from './listGuardStore';

export { VerificationReason, VerificationConfidence };

export type PrimaryVerificationResult =
  | 'DELIVERABLE'
  | 'UNDELIVERABLE'
  | 'CATCH_ALL'
  | 'UNKNOWN';

export interface CompleteVerificationResult {
  email: string;
  normalizedEmail: string;
  result: PrimaryVerificationResult;
  verificationReason: VerificationReason;
  confidence: VerificationConfidence;

  syntaxStatus: 'PASS' | 'FAIL';
  domainStatus: 'PASS' | 'FAIL' | 'UNKNOWN';
  mxStatus: 'PASS' | 'FAIL' | 'UNKNOWN';
  smtpStatus: string;

  isCatchAll: boolean;
  isDisposable: boolean;
  isRole: boolean;

  suppressionStatus: string | null;
  bounceStatus: string | null;

  smtpResponseCode: string | null;
  smtpResponse: string | null;

  reusedFromCache: boolean;
  verifiedAt: Date;
  expiresAt: Date;
}

export class VerificationEngine {
  private prisma: PrismaClient;
  private cacheTtlDays: number;

  constructor(prisma: PrismaClient, cacheTtlDays: number = 30) {
    this.prisma = prisma;
    const envTtl = process.env.LISTGUARD_CACHE_TTL_DAYS;
    this.cacheTtlDays = envTtl ? parseInt(envTtl, 10) : cacheTtlDays;
  }

  /**
   * Verifies a single email record following the complete ListGuard hierarchy.
   */
  public async verifyEmail(params: {
    rawEmail: string;
    userId?: string | undefined;
    contactId?: string | undefined;
    contactEmailId?: string | undefined;
    forceReverify?: boolean | undefined;
    smtpOptions?: SmtpVerifierOptions | undefined;
  }): Promise<CompleteVerificationResult> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.cacheTtlDays * 24 * 60 * 60 * 1000);

    // 1. Normalization
    const norm: NormalizedEmailResult = normalizeEmail(params.rawEmail);
    const { normalizedEmail, localPart, domain } = norm;

    // 2. Suppression check (checked BEFORE cache reuse so cached results never bypass suppression)
    let suppressionStatus: string | null = null;
    const suppressionWhere: any = { normalizedEmail };
    if (params.userId) {
      suppressionWhere.OR = [
        { userId: params.userId },
        { userId: null }
      ];
    }
    const suppressionEntry = await this.prisma.suppressionList.findFirst({
      where: suppressionWhere
    });

    if (suppressionEntry) {
      suppressionStatus = suppressionEntry.reason || 'SUPPRESSED';
    }

    // Also check Contact.doNotContact or unsubscribeAt if contactId provided
    if (params.contactId) {
      const contact = await this.prisma.contact.findUnique({
        where: { id: params.contactId },
        select: { doNotContact: true, unsubscribeAt: true }
      });
      if (contact?.doNotContact) {
        suppressionStatus = suppressionStatus || 'DO_NOT_CONTACT';
      } else if (contact?.unsubscribeAt) {
        suppressionStatus = suppressionStatus || 'UNSUBSCRIBED';
      }
    }

    if (suppressionStatus) {
      return {
        email: norm.rawEmail,
        normalizedEmail,
        result: 'UNDELIVERABLE',
        verificationReason: 'SUPPRESSED',
        confidence: 'HIGH',
        syntaxStatus: 'PASS',
        domainStatus: 'PASS',
        mxStatus: 'PASS',
        smtpStatus: 'UNDELIVERABLE_SIGNAL',
        isCatchAll: false,
        isDisposable: false,
        isRole: isRoleAccount(localPart),
        suppressionStatus,
        bounceStatus: null,
        smtpResponseCode: null,
        smtpResponse: `Address is suppressed: ${suppressionStatus}`,
        reusedFromCache: false,
        verifiedAt: now,
        expiresAt
      };
    }

    // 3. Historical Hard Bounce check (also checked BEFORE cache)
    let bounceStatus: string | null = null;
    if (params.contactEmailId) {
      const contactEmail = await this.prisma.contactEmail.findUnique({
        where: { id: params.contactEmailId },
        select: { verificationStatus: true, bounceCount: true }
      });

      if (contactEmail?.verificationStatus === 'bounced' || (contactEmail?.bounceCount && contactEmail.bounceCount > 0)) {
        bounceStatus = 'HARD_BOUNCE';
        return {
          email: norm.rawEmail,
          normalizedEmail,
          result: 'UNDELIVERABLE',
          verificationReason: 'HARD_BOUNCED',
          confidence: 'HIGH',
          syntaxStatus: 'PASS',
          domainStatus: 'PASS',
          mxStatus: 'PASS',
          smtpStatus: 'UNDELIVERABLE_SIGNAL',
          isCatchAll: false,
          isDisposable: false,
          isRole: isRoleAccount(localPart),
          suppressionStatus: null,
          bounceStatus,
          smtpResponseCode: null,
          smtpResponse: 'Address has a recorded historical bounce',
          reusedFromCache: false,
          verifiedAt: now,
          expiresAt
        };
      }
    }

    // 4. Verification Cache check
    if (!params.forceReverify) {
      const cached = await ListGuardStore.findCachedResult(
        this.prisma,
        normalizedEmail,
        now
      );

      if (cached) {
        const reason: VerificationReason =
          (cached.verificationReason as VerificationReason) ||
          (cached.result === 'DELIVERABLE'
            ? 'VALID_MAILBOX'
            : cached.result === 'UNDELIVERABLE'
            ? 'INVALID_MAILBOX'
            : cached.result === 'CATCH_ALL'
            ? 'CATCH_ALL_DOMAIN'
            : 'UNKNOWN');

        let cachedConfidence: VerificationConfidence = 'HIGH';
        if (cached.confidence === 'HIGH' || cached.confidence === 'MEDIUM' || cached.confidence === 'LOW') {
          cachedConfidence = cached.confidence;
        } else if (cached.result === 'UNKNOWN') {
          cachedConfidence = 'LOW';
        }

        return {
          email: norm.rawEmail,
          normalizedEmail,
          result: cached.result as PrimaryVerificationResult,
          verificationReason: reason,
          confidence: cachedConfidence,
          syntaxStatus: cached.syntaxStatus as any,
          domainStatus: cached.domainStatus as any,
          mxStatus: cached.mxStatus as any,
          smtpStatus: cached.smtpStatus,
          isCatchAll: cached.isCatchAll,
          isDisposable: cached.isDisposable,
          isRole: cached.isRole,
          suppressionStatus: cached.suppressionStatus || null,
          bounceStatus: cached.bounceStatus || null,
          smtpResponseCode: cached.smtpResponseCode || null,
          smtpResponse: cached.smtpResponse || null,
          reusedFromCache: true,
          verifiedAt: cached.verifiedAt,
          expiresAt: cached.expiresAt
        };
      }
    }

    // 5. Syntax check
    const syntax: SyntaxCheckResult = checkEmailSyntax(norm.normalizedEmail);
    if (!syntax.isValid) {
      return {
        email: norm.rawEmail,
        normalizedEmail,
        result: 'UNDELIVERABLE',
        verificationReason: 'INVALID_SYNTAX',
        confidence: 'HIGH',
        syntaxStatus: 'FAIL',
        domainStatus: 'FAIL',
        mxStatus: 'FAIL',
        smtpStatus: 'UNDELIVERABLE_SIGNAL',
        isCatchAll: false,
        isDisposable: false,
        isRole: false,
        suppressionStatus: null,
        bounceStatus: null,
        smtpResponseCode: null,
        smtpResponse: syntax.reason || 'Invalid email syntax',
        reusedFromCache: false,
        verifiedAt: now,
        expiresAt
      };
    }

    // 6. Role account check
    const isRole = isRoleAccount(localPart);

    // 7. Disposable domain check
    const isDisposable = isDisposableEmail(domain);
    if (isDisposable) {
      return {
        email: norm.rawEmail,
        normalizedEmail,
        result: 'UNDELIVERABLE',
        verificationReason: 'DISPOSABLE_DOMAIN',
        confidence: 'HIGH',
        syntaxStatus: 'PASS',
        domainStatus: 'PASS',
        mxStatus: 'PASS',
        smtpStatus: 'UNDELIVERABLE_SIGNAL',
        isCatchAll: false,
        isDisposable: true,
        isRole,
        suppressionStatus: null,
        bounceStatus: null,
        smtpResponseCode: null,
        smtpResponse: 'Disposable / temporary email domain detected',
        reusedFromCache: false,
        verifiedAt: now,
        expiresAt
      };
    }

    // 8. DNS & MX Check
    const dnsResult: DnsCheckResult = await checkDomainDns(domain);
    if (dnsResult.domainStatus === 'FAIL' || dnsResult.mxStatus === 'FAIL') {
      return {
        email: norm.rawEmail,
        normalizedEmail,
        result: 'UNDELIVERABLE',
        verificationReason: 'NO_MX',
        confidence: 'HIGH',
        syntaxStatus: 'PASS',
        domainStatus: dnsResult.domainStatus,
        mxStatus: dnsResult.mxStatus,
        smtpStatus: 'UNDELIVERABLE_SIGNAL',
        isCatchAll: false,
        isDisposable: false,
        isRole,
        suppressionStatus: null,
        bounceStatus,
        smtpResponseCode: null,
        smtpResponse: dnsResult.errorMessage || 'Domain or MX records do not exist',
        reusedFromCache: false,
        verifiedAt: now,
        expiresAt
      };
    }

    if (dnsResult.domainStatus === 'UNKNOWN' || dnsResult.mxStatus === 'UNKNOWN') {
      return {
        email: norm.rawEmail,
        normalizedEmail,
        result: 'UNKNOWN',
        verificationReason: 'UNKNOWN',
        confidence: 'LOW',
        syntaxStatus: 'PASS',
        domainStatus: dnsResult.domainStatus,
        mxStatus: dnsResult.mxStatus,
        smtpStatus: 'UNKNOWN',
        isCatchAll: false,
        isDisposable: false,
        isRole,
        suppressionStatus: null,
        bounceStatus,
        smtpResponseCode: null,
        smtpResponse: dnsResult.errorMessage || 'DNS lookup timed out or returned temporary error',
        reusedFromCache: false,
        verifiedAt: now,
        expiresAt
      };
    }

    // 9. SMTP Verification & Catch-All Detection
    const smtpResult: SmtpVerifyResult = await verifyEmailSmtp(
      norm.normalizedEmail,
      domain,
      dnsResult.mxHosts,
      params.smtpOptions
    );

    // 10. Map to the 4 primary results & structured reason
    let primaryResult: PrimaryVerificationResult;
    let reason: VerificationReason;
    let confidence: VerificationConfidence = smtpResult.confidence || 'HIGH';

    if (smtpResult.isCatchAll || smtpResult.smtpStatus === 'CATCH_ALL') {
      primaryResult = 'CATCH_ALL';
      reason = 'CATCH_ALL_DOMAIN';
      confidence = smtpResult.confidence || 'HIGH';
    } else if (smtpResult.smtpStatus === 'DELIVERABLE_SIGNAL') {
      primaryResult = 'DELIVERABLE';
      reason = isRole ? 'ROLE_ADDRESS' : (smtpResult.verificationReason || 'VALID_MAILBOX');
      confidence = smtpResult.confidence || 'HIGH';
    } else if (smtpResult.smtpStatus === 'UNDELIVERABLE_SIGNAL') {
      primaryResult = 'UNDELIVERABLE';
      reason = smtpResult.verificationReason || 'INVALID_MAILBOX';
      confidence = smtpResult.confidence || 'HIGH';
    } else {
      // TEMPORARY_FAILURE, GREYLISTED, or UNKNOWN
      primaryResult = 'UNKNOWN';
      reason = smtpResult.verificationReason || 'UNKNOWN';
      confidence = smtpResult.confidence || 'LOW';
    }

    return {
      email: norm.rawEmail,
      normalizedEmail,
      result: primaryResult,
      verificationReason: reason,
      confidence,
      syntaxStatus: 'PASS',
      domainStatus: dnsResult.domainStatus,
      mxStatus: dnsResult.mxStatus,
      smtpStatus: smtpResult.smtpStatus,
      isCatchAll: smtpResult.isCatchAll,
      isDisposable: false,
      isRole,
      suppressionStatus: null,
      bounceStatus,
      smtpResponseCode: smtpResult.smtpResponseCode || null,
      smtpResponse: smtpResult.smtpResponse || null,
      reusedFromCache: false,
      verifiedAt: now,
      expiresAt
    };
  }
}
