import assert from 'assert';
import http from 'http';
import { AddressInfo } from 'net';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { classifyPage } from '../src/services/leadIntelligence/pageClassifier';
import { extractFromDirectory } from '../src/services/leadIntelligence/directoryExtractor';
import { extractFromWebsite } from '../src/services/leadIntelligence/extractionService';
import { validatePublicUrl, validateHopUrl, UrlSecurityError } from '../src/services/leadIntelligence/urlFetcherService';
import { closeBrowser } from '../src/services/leadIntelligence/playwrightService';

async function runGenericDirectoryTests() {
  console.log('\n======================================================');
  console.log('🚀 RUNNING GENERIC DIRECTORY EXTRACTION TEST SUITE');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void | Promise<void>) {
    return Promise.resolve()
      .then(fn)
      .then(() => {
        console.log(`  ✅ PASS: ${name}`);
        passed++;
      })
      .catch((err: any) => {
        console.error(`  ❌ FAIL: ${name}`);
        console.error(`     Error: ${err.message}`);
        failed++;
      });
  }

  // ----------------------------------------------------
  // Set up synthetic test HTTP server
  // ----------------------------------------------------
  const server = http.createServer((req, res) => {
    const urlPath = req.url || '/';

    if (urlPath === '/directory') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Exhibitor Directory - Global Industry Expo 2026</title>
        </head>
        <body>
          <header>
            <h1>Global Industry Expo Exhibitor Directory</h1>
            <div class="organizer-box">
              <p>For stall bookings and inquiries, contact organizer:</p>
              <a href="mailto:exhibition@global-expo.org">exhibition@global-expo.org</a>
              <span>+1-800-555-0199</span>
            </div>
          </header>

          <main class="directory-container">
            <!-- Company A Card -->
            <div class="exhibitor-card">
              <h3>Alpha Aerospace Ltd</h3>
              <span class="category">Aviation & Defense</span>
              <p class="location">Seattle, USA</p>
              <a class="btn-profile" href="/detail/a">View Exhibitor Profile</a>
            </div>

            <!-- Company B Card -->
            <div class="exhibitor-card">
              <h3>Beta Biotech Inc</h3>
              <span class="category">Healthcare & Biotech</span>
              <p class="location">Boston, USA</p>
              <a class="btn-profile" href="/detail/b">View Exhibitor Profile</a>
            </div>

            <!-- Company C Card -->
            <div class="exhibitor-card">
              <h3>Gamma Robotics Corp</h3>
              <span class="category">Automation & AI</span>
              <p class="location">Austin, USA</p>
              <a class="btn-profile" href="/detail/c">View Exhibitor Profile</a>
            </div>

            <!-- Noise / External / Social links that must NOT become leads -->
            <div class="social-links">
              <a href="https://facebook.com/globalexpo">Facebook</a>
              <a href="https://linkedin.com/company/globalexpo">LinkedIn</a>
            </div>
          </main>

          <footer>
            <p>Expo Secretariat: info@global-expo.org | Tel: +1-800-555-0199</p>
          </footer>
        </body>
        </html>
      `);
      return;
    }

    if (urlPath === '/detail/a') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Alpha Aerospace Ltd - Profile</title></head>
        <body>
          <h1>Alpha Aerospace Ltd</h1>
          <div class="profile-details">
            <p><strong>Contact Person:</strong> Alice Anderson</p>
            <p><strong>Designation:</strong> Managing Director</p>
            <p><strong>Email:</strong> <a href="mailto:alice@alpha-aero.com">alice@alpha-aero.com</a></p>
            <p><strong>Phone:</strong> <a href="tel:+15550101">+1 (555) 0101</a></p>
            <p><strong>City:</strong> Seattle, Washington</p>
            <p><strong>Hall:</strong> Hall 1 / Booth A-101</p>
            <p><strong>Category:</strong> Aviation & Defense</p>
            <p><strong>Website:</strong> <a href="https://alpha-aero.com">https://alpha-aero.com</a></p>
          </div>
          <a href="/directory">Back to Directory</a>
        </body>
        </html>
      `);
      return;
    }

    if (urlPath === '/detail/b') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Beta Biotech Inc - Profile</title></head>
        <body>
          <h1>Beta Biotech Inc</h1>
          <div class="profile-details">
            <p><strong>Contact Person:</strong> Bob Brown</p>
            <p><strong>Designation:</strong> Head of R&D</p>
            <p><strong>Email:</strong> <a href="mailto:bob@betabiotech.io">bob@betabiotech.io</a></p>
            <p><strong>Phone:</strong> <a href="tel:+15550102">+1 (555) 0102</a></p>
            <p><strong>City:</strong> Boston, Massachusetts</p>
            <p><strong>Hall:</strong> Hall 2 / Booth B-204</p>
            <p><strong>Category:</strong> Healthcare & Biotech</p>
            <p><strong>Website:</strong> <a href="https://betabiotech.io">https://betabiotech.io</a></p>
          </div>
          <a href="/directory">Back to Directory</a>
        </body>
        </html>
      `);
      return;
    }

    if (urlPath === '/detail/c') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Gamma Robotics Corp - Profile</title></head>
        <body>
          <h1>Gamma Robotics Corp</h1>
          <div class="profile-details">
            <p><strong>Contact Person:</strong> Charlie Clark</p>
            <p><strong>Designation:</strong> VP Business Development</p>
            <p><strong>Email:</strong> <a href="mailto:charlie@gammarobotics.ai">charlie@gammarobotics.ai</a></p>
            <p><strong>Phone:</strong> <a href="tel:+15550103">+1 (555) 0103</a></p>
            <p><strong>City:</strong> Austin, Texas</p>
            <p><strong>Hall:</strong> Hall 3 / Booth C-309</p>
            <p><strong>Category:</strong> Automation & AI</p>
            <p><strong>Website:</strong> <a href="https://gammarobotics.ai">https://gammarobotics.ai</a></p>
          </div>
          <a href="/directory">Back to Directory</a>
        </body>
        </html>
      `);
      return;
    }

    if (urlPath === '/directory-inline') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Members Directory - Complete Inline Info</title></head>
        <body>
          <header><h1>Association Member Directory</h1></header>
          <div class="members-grid">
            <div class="card">
              <h3>Delta Logistics Services</h3>
              <p class="email"><a href="mailto:contact@deltalogistics.com">contact@deltalogistics.com</a></p>
              <p class="phone">+1 (555) 0104</p>
              <p class="location">Chicago, IL</p>
              <span class="badge">Logistics</span>
            </div>
            <div class="card">
              <h3>Epsilon Energy Solutions</h3>
              <p class="email"><a href="mailto:info@epsilonenergy.com">info@epsilonenergy.com</a></p>
              <p class="phone">+1 (555) 0105</p>
              <p class="location">Houston, TX</p>
              <span class="badge">Clean Energy</span>
            </div>
          </div>
          <footer>
            <p>Organizer: support@association.org</p>
          </footer>
        </body>
        </html>
      `);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // ----------------------------------------------------
    // TEST 1: Page Classifier recognizes Directory
    // ----------------------------------------------------
    console.log('--- TEST GROUP 1: Classification & Organizer Suppression ---');

    await test('classifyPage identifies directory page and extracts organizer emails', async () => {
      const dirHtml = `
        <html><head><title>Exhibitor Directory</title></head>
        <body>
          <div class="card"><h3>Company 1</h3><a href="/1">View</a></div>
          <div class="card"><h3>Company 2</h3><a href="/2">View</a></div>
          <div class="card"><h3>Company 3</h3><a href="/3">View</a></div>
          <div class="card"><h3>Company 4</h3><a href="/4">View</a></div>
          <div class="card"><h3>Company 5</h3><a href="/5">View</a></div>
          <footer>Contact organizer: exhibition@global-expo.org | +18005550199</footer>
        </body></html>
      `;
      const result = classifyPage(dirHtml, 'http://global-expo.org/directory');
      assert.strictEqual(result.pageType, 'DIRECTORY');
      assert(result.confidence >= 0.5);
      assert(result.organizerEmails.includes('exhibition@global-expo.org'));
    });

    // ----------------------------------------------------
    // TEST 2: Directory with Detail Pages (Company A, B, C)
    // ----------------------------------------------------
    console.log('\n--- TEST GROUP 2: Directory → Detail Page Architecture ---');

    await test('extractFromWebsite extracts 3 distinct leads from directory with detail pages', async () => {
      const result = await extractFromWebsite(`${baseUrl}/directory`, 'Synthetic Test Directory', {
        allowLoopback: true,
        mode: 'all',
      });

      assert.strictEqual(result.status, 'COMPLETED');
      assert.strictEqual(result.leads.length, 3, `Expected 3 leads, got ${result.leads.length}`);

      // Verify Company A
      const leadA = result.leads.find(l => l.companyName?.includes('Alpha Aerospace'));
      assert(leadA, 'Company A (Alpha Aerospace) not found');
      assert.strictEqual(leadA.contactName, 'Alice Anderson');
      assert.strictEqual(leadA.contactTitle, 'Managing Director');
      assert.strictEqual(leadA.email, 'alice@alpha-aero.com');
      assert(leadA.phone && leadA.phone.replace(/\D/g, '') === '15550101', `Expected 15550101, got ${leadA.phone}`);
      assert(leadA.city?.includes('Seattle'), `Expected city to include Seattle, got ${leadA.city}`);
      assert.strictEqual(leadA.domain, 'alpha-aero.com');
      assert(leadA.provenance.extractedFields.includes('email'));
      assert(leadA.provenance.extractedFields.includes('contactName'));

      // Verify Company B
      const leadB = result.leads.find(l => l.companyName?.includes('Beta Biotech'));
      assert(leadB, 'Company B (Beta Biotech) not found');
      assert.strictEqual(leadB.contactName, 'Bob Brown');
      assert.strictEqual(leadB.contactTitle, 'Head of R&D');
      assert.strictEqual(leadB.email, 'bob@betabiotech.io');
      assert(leadB.phone && leadB.phone.replace(/\D/g, '') === '15550102', `Expected 15550102, got ${leadB.phone}`);
      assert(leadB.city?.includes('Boston'), `Expected city to include Boston, got ${leadB.city}`);
      assert.strictEqual(leadB.domain, 'betabiotech.io');

      // Verify Company C
      const leadC = result.leads.find(l => l.companyName?.includes('Gamma Robotics'));
      assert(leadC, 'Company C (Gamma Robotics) not found');
      assert.strictEqual(leadC.contactName, 'Charlie Clark');
      assert.strictEqual(leadC.contactTitle, 'VP Business Development');
      assert.strictEqual(leadC.email, 'charlie@gammarobotics.ai');
      assert(leadC.phone && leadC.phone.replace(/\D/g, '') === '15550103', `Expected 15550103, got ${leadC.phone}`);
      assert(leadC.city?.includes('Austin'), `Expected city to include Austin, got ${leadC.city}`);
      assert.strictEqual(leadC.domain, 'gammarobotics.ai');

      // Verify metrics
      assert(result.metrics, 'Metrics object must be returned');
      assert.strictEqual(result.metrics.recordsDiscovered, 3);
      assert.strictEqual(result.metrics.detailUrlsDiscovered, 3);
      assert.strictEqual(result.metrics.detailPagesProcessed, 3);
      assert.strictEqual(result.metrics.successfulRecords, 3);
      assert.strictEqual(result.metrics.duplicates, 0);
      assert.strictEqual(result.metrics.failedPages, 0);

      // Verify organizer email is NEVER assigned to a lead
      const organizerAssigned = result.leads.some(l => l.email === 'exhibition@global-expo.org');
      assert.strictEqual(organizerAssigned, false, 'Organizer email must not be assigned to any lead');
    });

    // ----------------------------------------------------
    // TEST 3: Directory with Complete Inline Information
    // ----------------------------------------------------
    console.log('\n--- TEST GROUP 3: Complete Inline Directory ---');

    await test('extractFromWebsite extracts leads directly from inline directory without detail pages', async () => {
      const result = await extractFromWebsite(`${baseUrl}/directory-inline`, 'Inline Test Directory', {
        allowLoopback: true,
      });

      assert.strictEqual(result.status, 'COMPLETED');
      assert.strictEqual(result.leads.length, 2, `Expected 2 leads, got ${result.leads.length}`);

      const delta = result.leads.find(l => l.companyName?.includes('Delta Logistics'));
      assert(delta, 'Delta Logistics not found');
      assert.strictEqual(delta.email, 'contact@deltalogistics.com');
      assert(delta.phone && delta.phone.replace(/\D/g, '') === '15550104', `Expected 15550104, got ${delta.phone}`);
      assert.strictEqual(delta.city, 'Chicago, IL');

      const epsilon = result.leads.find(l => l.companyName?.includes('Epsilon Energy'));
      assert(epsilon, 'Epsilon Energy not found');
      assert.strictEqual(epsilon.email, 'info@epsilonenergy.com');
      assert(epsilon.phone && epsilon.phone.replace(/\D/g, '') === '15550105', `Expected 15550105, got ${epsilon.phone}`);
      assert.strictEqual(epsilon.city, 'Houston, TX');

      // Organizer email must NOT be a lead
      const organizerLead = result.leads.some(l => l.email === 'support@association.org');
      assert.strictEqual(organizerLead, false, 'Organizer email must not become a lead');
    });

    // ----------------------------------------------------
    // TEST 4: Configurable Processing Limits
    // ----------------------------------------------------
    console.log('\n--- TEST GROUP 4: Configurable Limits (sample / limited / all) ---');

    await test('sample mode caps detail extraction at 1 record when maxDetailPages=1', async () => {
      const result = await extractFromWebsite(`${baseUrl}/directory`, 'Limited Test Directory', {
        allowLoopback: true,
        maxDetailPages: 1,
      });

      assert.strictEqual(result.status, 'COMPLETED');
      assert.strictEqual(result.leads.length, 1, `Expected 1 lead with maxDetailPages=1, got ${result.leads.length}`);
      assert.strictEqual(result.metrics.detailPagesProcessed, 1);
      assert.strictEqual(result.metrics.recordsDiscovered, 1);
    });

    // ----------------------------------------------------
    // TEST 5: SSRF Security Validation on Every Hop
    // ----------------------------------------------------
    console.log('\n--- TEST GROUP 5: SSRF Protection on Every Hop ---');

    await test('validateHopUrl strictly blocks cloud metadata hop (169.254.169.254)', async () => {
      let threw = false;
      try {
        await validateHopUrl('http://169.254.169.254/latest/meta-data/', `${baseUrl}/directory`);
      } catch (err: any) {
        threw = true;
        assert(err instanceof UrlSecurityError || err.name === 'UrlSecurityError');
      }
      assert.strictEqual(threw, true, 'Cloud metadata IP must be strictly blocked');
    });

    await test('validateHopUrl strictly blocks GCP metadata host', async () => {
      let threw = false;
      try {
        await validateHopUrl('http://metadata.google.internal/computeMetadata/v1/', `${baseUrl}/directory`);
      } catch (err: any) {
        threw = true;
        assert(err instanceof UrlSecurityError || err.name === 'UrlSecurityError');
      }
      assert.strictEqual(threw, true, 'GCP metadata host must be strictly blocked');
    });

    await test('validateHopUrl strictly blocks private loopback when allowLoopback is false', async () => {
      let threw = false;
      try {
        await validateHopUrl(`${baseUrl}/detail/a`, 'http://example.com', { allowLoopback: false });
      } catch (err: any) {
        threw = true;
        assert(err instanceof UrlSecurityError || err.name === 'UrlSecurityError');
      }
      assert.strictEqual(threw, true, 'Loopback IP must be blocked when allowLoopback is false');
    });

  } finally {
    server.close();
  }

  console.log('\n======================================================');
  console.log(`SUMMARY: ${passed} PASSED | ${failed} FAILED`);
  console.log('======================================================\n');

  await closeBrowser();

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runGenericDirectoryTests().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
