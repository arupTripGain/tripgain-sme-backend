import dns from 'dns';

export interface DnsCheckResult {
  domainStatus: 'PASS' | 'FAIL' | 'UNKNOWN';
  mxStatus: 'PASS' | 'FAIL' | 'UNKNOWN';
  mxHosts: string[];
  errorMessage?: string;
}

/**
 * Executes a promise with a bounded timeout.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMsg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMsg)), timeoutMs);
    promise
      .then(res => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// In-memory DNS cache to avoid hammering DNS servers for repeated domains in a list
const domainDnsCache = new Map<string, { result: DnsCheckResult; expiresAt: number }>();
const DNS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Checks DNS domain existence and MX host records.
 * Follows RFC 5321: if no MX record is found, checks for A/AAAA fallback.
 */
export async function checkDomainDns(domain: string, timeoutMs: number = 4000): Promise<DnsCheckResult> {
  if (!domain || typeof domain !== 'string') {
    return {
      domainStatus: 'FAIL',
      mxStatus: 'FAIL',
      mxHosts: [],
      errorMessage: 'Invalid domain parameter'
    };
  }

  const cleanDomain = domain.toLowerCase().trim();

  // Check cache first
  const cached = domainDnsCache.get(cleanDomain);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  try {
    // 1. Resolve MX records
    let mxRecords: dns.MxRecord[] = [];
    try {
      mxRecords = await withTimeout(
        dns.promises.resolveMx(cleanDomain),
        timeoutMs,
        'DNS MX lookup timed out'
      );
    } catch (err: any) {
      // If code is ENODATA or ENOTFOUND, domain might still have A records or simply doesn't exist
      if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
        mxRecords = [];
      } else if (err.code === 'ETIMEOUT' || err.message?.includes('timed out')) {
        return {
          domainStatus: 'UNKNOWN',
          mxStatus: 'UNKNOWN',
          mxHosts: [],
          errorMessage: 'DNS MX resolution timed out'
        };
      } else {
        mxRecords = [];
      }
    }

    let finalResult: DnsCheckResult;

    if (mxRecords && mxRecords.length > 0) {
      // Sort by priority ascending (lowest number = highest preference)
      const sortedHosts = mxRecords
        .sort((a, b) => a.priority - b.priority)
        .map(r => r.exchange.toLowerCase().trim())
        .filter(Boolean);

      finalResult = {
        domainStatus: 'PASS',
        mxStatus: 'PASS',
        mxHosts: sortedHosts
      };
    } else {
      // 2. RFC 5321 Fallback: No MX record, check A / AAAA records
      let aHosts: string[] = [];
      try {
        const aRecords = await withTimeout(
          dns.promises.resolve4(cleanDomain),
          timeoutMs,
          'DNS A lookup timed out'
        );
        if (aRecords && aRecords.length > 0) {
          aHosts = [cleanDomain];
        }
      } catch (aErr: any) {
        if (aErr.code === 'ENOTFOUND' || aErr.code === 'ENODATA') {
          try {
            const aaaaRecords = await withTimeout(
              dns.promises.resolve6(cleanDomain),
              timeoutMs,
              'DNS AAAA lookup timed out'
            );
            if (aaaaRecords && aaaaRecords.length > 0) {
              aHosts = [cleanDomain];
            }
          } catch {}
        }
      }

      if (aHosts.length > 0) {
        finalResult = {
          domainStatus: 'PASS',
          mxStatus: 'PASS',
          mxHosts: aHosts
        };
      } else {
        finalResult = {
          domainStatus: 'FAIL',
          mxStatus: 'FAIL',
          mxHosts: [],
          errorMessage: 'No mail exchange (MX) or address (A) records found for domain'
        };
      }
    }

    domainDnsCache.set(cleanDomain, {
      result: finalResult,
      expiresAt: Date.now() + DNS_CACHE_TTL_MS
    });
    return finalResult;
  } catch (error: any) {
    const errorResult: DnsCheckResult = {
      domainStatus: error.code === 'ENOTFOUND' ? 'FAIL' : 'UNKNOWN',
      mxStatus: error.code === 'ENOTFOUND' ? 'FAIL' : 'UNKNOWN',
      mxHosts: [],
      errorMessage: error.message || 'DNS resolution failed'
    };
    domainDnsCache.set(cleanDomain, {
      result: errorResult,
      expiresAt: Date.now() + (error.code === 'ENOTFOUND' ? DNS_CACHE_TTL_MS : 30000)
    });
    return errorResult;
  }
}
