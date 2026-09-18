/**
 * Provider-Specific SMTP Interpretation Rules for ListGuard
 * Interprets SMTP status code, text, and provider signatures conservatively:
 * - Google Workspace / Gmail
 * - Microsoft 365 / Exchange Online
 * - Proofpoint
 * - Mimecast
 * - Barracuda
 * - Spamhaus & Security Gateways
 *
 * CRITICAL RULE:
 * Ambiguous security gateways, DNSBL, rate blocks, or policy rejections
 * NEVER become DELIVERABLE or UNDELIVERABLE. They remain UNKNOWN (SMTP_BLOCKED / GREYLISTED).
 */

import { SmtpSignalStatus, VerificationReason } from './smtpVerifier';

export type VerificationConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ProviderInterpretationResult {
  status: SmtpSignalStatus;
  reason: VerificationReason;
  confidence: VerificationConfidence;
  isNetworkOrGatewayFailure: boolean;
  providerDetected: string;
}

export class ProviderRules {
  /**
   * Detects the dominant destination provider from the MX host list.
   */
  public static identifyProvider(mxHosts: string[]): string {
    const joined = (mxHosts || []).join(' ').toLowerCase();
    if (/google\.com|googlemail\.com|aspmx/i.test(joined)) return 'GOOGLE';
    if (/protection\.outlook\.com|outlook\.com|microsoft/i.test(joined)) return 'MICROSOFT';
    if (/pphosted\.com|proofpoint/i.test(joined)) return 'PROOFPOINT';
    if (/mimecast/i.test(joined)) return 'MIMECAST';
    if (/barracuda/i.test(joined)) return 'BARRACUDA';
    return 'GENERIC';
  }

  /**
   * Interprets the raw SMTP response based on status code, response string, and provider.
   */
  public static interpretResponse(params: {
    code: number;
    response: string;
    mxHosts: string[];
  }): ProviderInterpretationResult {
    const { code, response, mxHosts } = params;
    const resLower = (response || '').toLowerCase();
    const provider = this.identifyProvider(mxHosts);

    // 1. Detect Security, Reputation, RBL, and IP Gateways across any provider
    const isSecurityGateway =
      /blocked|blacklisted|blacklist|spamhaus|sorbs|barracuda|proofpoint|mimecast|reputation|relay denied|relay access denied|administrative prohibition|policy rejection|5\.7\.1|5\.7\.0|dnsbl|rbl|service unavailable|connection dropped/i.test(
        resLower
      ) || code === 554;

    if (isSecurityGateway) {
      return {
        status: 'UNKNOWN',
        reason: 'SMTP_BLOCKED',
        confidence: 'LOW',
        isNetworkOrGatewayFailure: true,
        providerDetected: provider
      };
    }

    // 2. Google Workspace / Gmail Rules
    if (provider === 'GOOGLE') {
      if (code >= 200 && code < 300) {
        return {
          status: 'DELIVERABLE_SIGNAL',
          reason: 'VALID_MAILBOX',
          confidence: 'HIGH',
          isNetworkOrGatewayFailure: false,
          providerDetected: provider
        };
      }
      // Google: 550 5.1.1 "The email account that you tried to reach does not exist"
      if (code === 550 && (resLower.includes('5.1.1') || resLower.includes('does not exist'))) {
        return {
          status: 'UNDELIVERABLE_SIGNAL',
          reason: 'INVALID_MAILBOX',
          confidence: 'HIGH',
          isNetworkOrGatewayFailure: false,
          providerDetected: provider
        };
      }
      // Google temporary rate limits or grey: 421 / 450 / 452
      if (code >= 400 && code < 500) {
        return {
          status: 'GREYLISTED',
          reason: 'GREYLISTED',
          confidence: 'MEDIUM',
          isNetworkOrGatewayFailure: false,
          providerDetected: provider
        };
      }
    }

    // 3. Microsoft 365 / Exchange Online Rules
    if (provider === 'MICROSOFT') {
      if (code >= 200 && code < 300) {
        return {
          status: 'DELIVERABLE_SIGNAL',
          reason: 'VALID_MAILBOX',
          confidence: 'HIGH',
          isNetworkOrGatewayFailure: false,
          providerDetected: provider
        };
      }
      // Microsoft: 550 5.4.1 "Recipient address rejected: Access denied"
      // Classify as INVALID_MAILBOX only when clearly recipient rejection
      if (code === 550 && (resLower.includes('5.4.1') || resLower.includes('5.1.1') || resLower.includes('user unknown'))) {
        // If it's tenant-level or directory block, remain conservative
        if (resLower.includes('hop count') || resLower.includes('loop') || resLower.includes('tenant')) {
          return {
            status: 'UNKNOWN',
            reason: 'SMTP_BLOCKED',
            confidence: 'LOW',
            isNetworkOrGatewayFailure: true,
            providerDetected: provider
          };
        }
        return {
          status: 'UNDELIVERABLE_SIGNAL',
          reason: 'INVALID_MAILBOX',
          confidence: 'HIGH',
          isNetworkOrGatewayFailure: false,
          providerDetected: provider
        };
      }
      if (code >= 400 && code < 500) {
        return {
          status: 'GREYLISTED',
          reason: 'GREYLISTED',
          confidence: 'MEDIUM',
          isNetworkOrGatewayFailure: false,
          providerDetected: provider
        };
      }
    }

    // 4. Proofpoint / Mimecast / Barracuda Specific
    if (provider === 'PROOFPOINT' || provider === 'MIMECAST' || provider === 'BARRACUDA') {
      if (code >= 200 && code < 300) {
        // Even if 250, enterprise filters often accept all recipients then bounce later
        return {
          status: 'DELIVERABLE_SIGNAL',
          reason: 'VALID_MAILBOX',
          confidence: 'MEDIUM', // Marked MEDIUM confidence due to gateway bounce probability
          isNetworkOrGatewayFailure: false,
          providerDetected: provider
        };
      }
      if (code >= 400 && code < 500) {
        return {
          status: 'GREYLISTED',
          reason: 'GREYLISTED',
          confidence: 'LOW',
          isNetworkOrGatewayFailure: false,
          providerDetected: provider
        };
      }
    }

    // 5. Generic SMTP Behavior
    if (code >= 200 && code < 300) {
      return {
        status: 'DELIVERABLE_SIGNAL',
        reason: 'VALID_MAILBOX',
        confidence: 'HIGH',
        isNetworkOrGatewayFailure: false,
        providerDetected: provider
      };
    }

    if (code >= 500 && code < 600) {
      // 550 User Unknown / Mailbox not found
      return {
        status: 'UNDELIVERABLE_SIGNAL',
        reason: 'INVALID_MAILBOX',
        confidence: 'HIGH',
        isNetworkOrGatewayFailure: false,
        providerDetected: provider
      };
    }

    if (code >= 400 && code < 500) {
      return {
        status: 'GREYLISTED',
        reason: 'GREYLISTED',
        confidence: 'MEDIUM',
        isNetworkOrGatewayFailure: false,
        providerDetected: provider
      };
    }

    return {
      status: 'UNKNOWN',
      reason: 'UNKNOWN',
      confidence: 'LOW',
      isNetworkOrGatewayFailure: false,
      providerDetected: provider
    };
  }
}
