import http from 'http';
import https from 'https';
import dns from 'dns';
import { promisify } from 'util';
import * as cheerio from 'cheerio';

const lookupAsync = promisify(dns.lookup);

export interface FetchedWebContent {
  url: string;
  finalUrl: string;
  title: string;
  metaDescription?: string | undefined;
  textContent: string;
  extractedEmails: string[];
  extractedPhones: string[];
  links: string[];
  html: string;
}

export class UrlSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlSecurityError';
  }
}

/**
 * Validates if an IP address falls within private/loopback/cloud-metadata ranges.
 */
export function isPrivateOrRestrictedIp(ip: string): boolean {
  // IPv4 checks
  const ipv4Parts = ip.split('.').map(Number);
  if (ipv4Parts.length === 4 && ipv4Parts.every(p => !isNaN(p) && p >= 0 && p <= 255)) {
    const [a, b, c, d] = ipv4Parts;
    if (a === undefined || b === undefined || c === undefined || d === undefined) return false;
    // 0.0.0.0/8
    if (a === 0) return true;
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 10.0.0.0/8 (private)
    if (a === 10) return true;
    // 172.16.0.0/12 (private: 172.16.0.0 - 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 (private)
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (link-local / AWS / GCP / Azure metadata endpoint: 169.254.169.254)
    if (a === 169 && b === 254) return true;
    // 100.64.0.0/10 (carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // Broadcast
    if (a === 255 && b === 255 && c === 255 && d === 255) return true;
    return false;
  }

  // IPv6 checks
  const lowerIp = ip.toLowerCase();
  if (lowerIp === '::1' || lowerIp === '::' || lowerIp.startsWith('fe80:') || lowerIp.startsWith('fc00:') || lowerIp.startsWith('fd00:')) {
    return true;
  }

  return false;
}

export interface FetchUrlOptions {
  timeoutMs?: number | undefined;
  maxSizeBytes?: number | undefined;
  allowLoopback?: boolean | undefined;
}

/**
 * Validates URL scheme and resolves DNS to verify IP address before connecting.
 */
export async function validatePublicUrl(
  targetUrl: string,
  options?: { allowLoopback?: boolean | undefined }
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new UrlSecurityError(`Invalid URL format: ${targetUrl}`);
  }

  // Strictly allow only http and https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlSecurityError(`Prohibited protocol "${parsed.protocol}". Only HTTP and HTTPS are permitted.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const allowLoopback = options?.allowLoopback || process.env.ALLOW_LOOPBACK_FOR_TESTING === 'true';

  // Hostname string checks
  const isLocalHost = hostname === 'localhost' || hostname.endsWith('.localhost');
  if (isLocalHost && !allowLoopback) {
    throw new UrlSecurityError(`Access to internal/local hostname "${hostname}" is prohibited.`);
  }

  if (
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal' ||
    hostname === 'instance-data'
  ) {
    throw new UrlSecurityError(`Access to internal/local hostname "${hostname}" is prohibited.`);
  }

  // Resolve hostname to IP to block DNS rebinding / private IP targets
  try {
    const lookupResult = await lookupAsync(hostname);
    const ip = lookupResult.address;
    
    // Check cloud metadata strictly
    if (ip === '169.254.169.254' || ip.startsWith('169.254.')) {
      throw new UrlSecurityError(`Target resolved to cloud metadata IP (${ip}). Access blocked.`);
    }

    if (isPrivateOrRestrictedIp(ip)) {
      const isLoopbackIp = ip === '127.0.0.1' || ip === '::1';
      if (!(allowLoopback && isLoopbackIp)) {
        throw new UrlSecurityError(`Target resolved to a private or restricted IP address (${ip}). Access blocked.`);
      }
    }
  } catch (err: any) {
    if (err instanceof UrlSecurityError) throw err;
    throw new UrlSecurityError(`Unable to resolve host "${hostname}": ${err.message}`);
  }

  return parsed;
}

/**
 * Validates a secondary hop (detail link, iframe, redirect, pagination) against SSRF
 */
export async function validateHopUrl(
  hopUrl: string,
  baseOriginUrl: string,
  options?: { allowLoopback?: boolean | undefined }
): Promise<string> {
  const resolved = new URL(hopUrl, baseOriginUrl).toString();
  await validatePublicUrl(resolved, options);
  return resolved;
}

/**
 * SSRF-protected, size-limited, timeout-bounded public web scraper
 */
export async function fetchPublicUrl(
  targetUrl: string,
  options: FetchUrlOptions = {}
): Promise<FetchedWebContent> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxSizeBytes = options.maxSizeBytes ?? 5 * 1024 * 1024; // 5 MB

  const validatedUrl = await validatePublicUrl(targetUrl, { allowLoopback: options.allowLoopback });

  return new Promise<FetchedWebContent>((resolve, reject) => {
    const isHttps = validatedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const requestOptions = {
      hostname: validatedUrl.hostname,
      port: validatedUrl.port || (isHttps ? 443 : 80),
      path: validatedUrl.pathname + validatedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'TripGainLeadIntelligenceBot/1.0 (+https://tripgain.com; SME Research)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: timeoutMs,
    };

    const req = client.request(requestOptions, (res) => {
      // Check status code
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Resolve redirect URL and validate recursively
        const redirectUrl = new URL(res.headers.location, targetUrl).toString();
        // Disallow more than 3 redirects to prevent infinite loops
        fetchPublicUrl(redirectUrl, { timeoutMs, maxSizeBytes, allowLoopback: options.allowLoopback })
          .then(resolve)
          .catch(reject);
        return;
      }

      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 400)) {
        reject(new Error(`HTTP error ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      let totalBytes = 0;
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxSizeBytes) {
          req.destroy();
          reject(new Error(`Response exceeded maximum size limit of ${maxSizeBytes / (1024 * 1024)}MB.`));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        const html = bodyBuffer.toString('utf-8');

        try {
          const $ = cheerio.load(html);

          // Strip script and style tags
          $('script, style, noscript, svg, nav, footer, header').remove();

          const title = $('title').first().text().trim() || $('h1').first().text().trim() || '';
          const metaDescription = $('meta[name="description"]').attr('content')?.trim() ||
            $('meta[property="og:description"]').attr('content')?.trim();

          const textContent = $('body').text().replace(/\s+/g, ' ').trim();

          // Extract potential emails via regex
          const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
          const emails = Array.from(new Set(html.match(emailRegex) || []))
            .filter(e => !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.gif') && !e.endsWith('.svg'));

          // Extract potential phone numbers
          const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g;
          const rawPhones = html.match(phoneRegex) || [];
          const phones = Array.from(new Set(rawPhones.map(p => p.trim()))).filter(p => p.length >= 8 && p.length <= 20);

          // Extract anchor links
          const links: string[] = [];
          $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
              try {
                const absolute = new URL(href, targetUrl).toString();
                links.push(absolute);
              } catch {
                // Ignore malformed href
              }
            }
          });

          resolve({
            url: targetUrl,
            finalUrl: targetUrl,
            title,
            metaDescription,
            textContent: textContent.slice(0, 10000), // Cap preview text
            extractedEmails: emails.slice(0, 10),
            extractedPhones: phones.slice(0, 10),
            links: Array.from(new Set(links)).slice(0, 20),
            html,
          });
        } catch (err: any) {
          reject(new Error(`Failed to parse HTML from URL: ${err.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms.`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}
