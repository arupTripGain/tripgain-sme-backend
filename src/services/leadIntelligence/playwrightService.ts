import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { validatePublicUrl, validateHopUrl, UrlSecurityError } from './urlFetcherService';

export interface PlaywrightRenderOptions {
  timeoutMs?: number | undefined;
  waitForSelector?: string | undefined;
  captureJsonResponses?: boolean | undefined;
  allowLoopback?: boolean | undefined;
  maxRequests?: number | undefined;
  withPage?: ((page: Page, capturedJsonPayloads: any[]) => Promise<any>) | undefined;
}

export interface PlaywrightRenderResult {
  url: string;
  finalUrl: string;
  html: string;
  frameHtmls: Array<{ url: string; html: string }>;
  capturedJsonPayloads: any[];
  requestsMade: number;
}

let sharedBrowser: Browser | null = null;

/**
 * Gets or initializes a headless browser instance.
 * Tries system Chrome first, falls back to bundled Chromium.
 */
async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }

  try {
    sharedBrowser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  } catch {
    sharedBrowser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }

  return sharedBrowser;
}

/**
 * Closes the shared browser instance if active
 */
export async function closeBrowser(): Promise<void> {
  if (sharedBrowser) {
    try {
      await sharedBrowser.close();
    } catch {}
    sharedBrowser = null;
  }
}

/**
 * Recursively inspects JSON payloads for candidate record arrays (handles pagination wrappers like data.items)
 */
export function findRecordArray(obj: any, depth = 0): any[] | null {
  if (!obj || depth > 3) return null;
  if (Array.isArray(obj) && obj.length >= 2) return obj;
  if (typeof obj === 'object') {
    for (const key of ['items', 'results', 'data', 'records', 'exhibitors', 'companies', 'list', 'rows', 'members', 'attendees']) {
      if (Array.isArray(obj[key]) && obj[key].length >= 2) {
        return obj[key];
      }
    }
    for (const subKey of ['data', 'response', 'payload', 'result']) {
      if (obj[subKey] && typeof obj[subKey] === 'object') {
        const nested = findRecordArray(obj[subKey], depth + 1);
        if (nested) return nested;
      }
    }
  }
  return null;
}

/**
 * Renders a dynamic web page with Playwright, handling JS hydration, child iframes,
 * SSRF validation on every request, and public JSON payload interception.
 */
export async function renderPageWithPlaywright(
  targetUrl: string,
  options: PlaywrightRenderOptions = {}
): Promise<PlaywrightRenderResult> {
  const timeoutMs = options.timeoutMs ?? 25000;
  const maxRequests = options.maxRequests ?? 200;
  const allowLoopback = options.allowLoopback || process.env.ALLOW_LOOPBACK_FOR_TESTING === 'true';

  // 1. SSRF validation on target URL
  await validatePublicUrl(targetUrl, { allowLoopback });

  const browser = await getBrowser();
  const context: BrowserContext = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: false,
  });

  let requestsMade = 0;
  const capturedJsonPayloads: any[] = [];
  const frameHtmls: Array<{ url: string; html: string }> = [];

  try {
    const page: Page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    // 2. SSRF check on EVERY sub-request via page route
    await page.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      requestsMade++;

      if (requestsMade > maxRequests) {
        await route.abort('failed');
        return;
      }

      // Block data URIs or non-http
      if (requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) {
        await route.continue();
        return;
      }

      try {
        await validateHopUrl(requestUrl, targetUrl, { allowLoopback });
        await route.continue();
      } catch {
        // Block SSRF violating requests
        await route.abort('blockedbyclient');
      }
    });

    // 3. Network response interception for public data endpoints (JSON arrays)
    if (options.captureJsonResponses !== false) {
      page.on('response', async (res) => {
        try {
          const contentType = res.headers()['content-type'] || '';
          if (contentType.includes('application/json') || contentType.includes('text/json')) {
            const resUrl = res.url();
            // Verify hop URL passes SSRF before parsing
            await validateHopUrl(resUrl, targetUrl, { allowLoopback });
            
            const json = await res.json().catch(() => null);
            if (json) {
              const reqHeaders = res.request().headers();
              const reqMethod = res.request().method();
              const records = findRecordArray(json);
              if (records && records.length >= 2) {
                capturedJsonPayloads.push({
                  url: resUrl,
                  data: records,
                  rawResponse: json,
                  headers: reqHeaders,
                  method: reqMethod,
                });
              } else {
                const singleObj = json.data && typeof json.data === 'object' && !Array.isArray(json.data) ? json.data : json;
                if (singleObj && typeof singleObj === 'object') {
                  const hasCompanyOrContact = Boolean(
                    singleObj.companyName || singleObj.exhibitorName || singleObj.company_name ||
                    singleObj.contactPersonName || singleObj.contactPerson || singleObj.contact_person
                  );
                  if (hasCompanyOrContact) {
                    capturedJsonPayloads.push({
                      url: resUrl,
                      data: [singleObj],
                      rawResponse: json,
                      headers: reqHeaders,
                      method: reqMethod,
                    });
                  }
                }
              }
            }
          }
        } catch {}
      });
    }

    // 4. Navigate to page
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    // 5. Wait for dynamic rendering / selector if specified
    if (options.waitForSelector) {
      try {
        await page.waitForSelector(options.waitForSelector, { timeout: 8000 });
      } catch {}
    } else {
      // General settling time for client-side frameworks (Next.js, React, Vue)
      // Poll dynamically up to 10s or exit early once background JSON payloads have arrived
      const startTime = Date.now();
      const maxWaitMs = 10000;
      while (Date.now() - startTime < maxWaitMs) {
        if (capturedJsonPayloads.length > 0) {
          await page.waitForTimeout(800);
          break;
        }
        await page.waitForTimeout(400);
      }
    }

    const finalUrl = page.url();
    const html = await page.content();

    // 6. Inspect frames (iframes)
    for (const frame of page.frames()) {
      const frameUrl = frame.url();
      if (frameUrl && frameUrl !== 'about:blank' && frameUrl !== targetUrl && frameUrl !== finalUrl) {
        try {
          await validateHopUrl(frameUrl, targetUrl, { allowLoopback });
          const fHtml = await frame.content();
          if (fHtml && fHtml.length > 200) {
            frameHtmls.push({ url: frameUrl, html: fHtml });
          }
        } catch {}
      }
    }

    if (options.withPage) {
      try {
        await options.withPage(page, capturedJsonPayloads);
      } catch (err: any) {
        console.warn('options.withPage callback threw error:', err.message);
      }
    }

    return {
      url: targetUrl,
      finalUrl,
      html,
      frameHtmls,
      capturedJsonPayloads,
      requestsMade,
    };
  } finally {
    await context.close().catch(() => {});
  }
}
