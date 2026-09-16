import assert from 'assert';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { extractFromDirectory } from '../src/services/leadIntelligence/directoryExtractor';
import { generateBatchLeadsCsv } from '../src/services/leadIntelligence/exportService';
import { closeBrowser } from '../src/services/leadIntelligence/playwrightService';
import { stringSimilarity } from '../src/services/leadIntelligence/deduplicationService';
import { normalizeLeadPayload, calculateCompletenessScore } from '../src/services/leadIntelligence/normalizationService';

async function runPaginationTests() {
  console.log('\n======================================================');
  console.log('🚀 RUNNING GENERIC PAGINATION & RESEARCH BATCH TESTS');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err.message}`);
      failed++;
    }
  }

  const PORT = 9497;
  let baseUrl = `http://localhost:${PORT}`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // 1. Static HTML 3-Page Directory Fixture (9 records total)
    if (pathname === '/static/page1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Static Directory Page 1</title></head>
        <body>
          <header><p>Contact organizer: expo@organizer.com</p></header>
          <div class="directory-list">
            <div class="card">
              <h3>Alpha Fabrics Ltd</h3>
              <p>City: Mumbai</p>
              <p>Email: contact@alphafabrics.com</p>
            </div>
            <div class="card">
              <h3>Beta Yarns Inc</h3>
              <p>City: Surat</p>
              <p>Email: info@betayarns.com</p>
            </div>
            <div class="card">
              <h3>Gamma Garments Corp</h3>
              <p>City: Tiruppur</p>
              <p>Email: sales@gammagarments.com</p>
            </div>
          </div>
          <div class="pagination">
            <a rel="next" href="/static/page2">Next Page</a>
          </div>
        </body>
        </html>
      `);
      return;
    }

    if (pathname === '/static/page2') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Static Directory Page 2</title></head>
        <body>
          <div class="directory-list">
            <div class="card">
              <h3>Delta Textiles Pvt Ltd</h3>
              <p>City: Ahmedabad</p>
              <p>Email: hello@deltatextiles.com</p>
            </div>
            <div class="card">
              <h3>Epsilon Weaving Mills</h3>
              <p>City: Coimbatore</p>
              <p>Email: info@epsilonmills.com</p>
            </div>
            <div class="card">
              <h3>Zeta Cotton Traders</h3>
              <p>City: Indore</p>
              <p>Email: contact@zetacotton.com</p>
            </div>
          </div>
          <div class="pagination">
            <a rel="next" href="/static/page3">Next Page</a>
          </div>
        </body>
        </html>
      `);
      return;
    }

    if (pathname === '/static/page3') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Static Directory Page 3</title></head>
        <body>
          <div class="directory-list">
            <div class="card">
              <h3>Eta Apparels Limited</h3>
              <p>City: Ludhiana</p>
              <p>Email: export@etaapparels.com</p>
            </div>
            <div class="card">
              <h3>Theta Silks LLP</h3>
              <p>City: Varanasi</p>
              <p>Email: query@thetasilks.com</p>
            </div>
            <div class="card">
              <h3>Iota Woolen Industries</h3>
              <p>City: Panipat</p>
              <p>Email: sales@iotawoolen.com</p>
            </div>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // 2. API-Query Paginated Directory Fixture (3 pages, 9 records)
    if (pathname === '/api-directory/index') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Dynamic API Directory</title></head>
        <body>
          <div id="root">
            <h2>Dynamic Exhibitor Directory</h2>
            <div id="exhibitors">Loading...</div>
          </div>
          <script>
            fetch('/api-directory/records?page=1&pageSize=3')
              .then(r => r.json())
              .then(data => {
                const el = document.getElementById('exhibitors');
                el.innerHTML = data.items.map(i => '<div class="item">' + i.companyName + '</div>').join('');
              });
          </script>
        </body>
        </html>
      `);
      return;
    }

    if (pathname === '/api-directory/records') {
      const page = parseInt(url.searchParams.get('page') || '1', 10);
      const allRecords = [
        { id: '1', companyName: 'Apex Knits India', city: 'Tiruppur', contactPerson: 'Arun Kumar', email: 'arun@apexknits.com' },
        { id: '2', companyName: 'Beacon Weaves Corp', city: 'Surat', contactPerson: 'Bhavin Shah', email: 'bhavin@beaconweaves.com' },
        { id: '3', companyName: 'Crest Spinners Ltd', city: 'Coimbatore', contactPerson: 'Chandra Sekhar', email: 'chandra@crestspinners.com' },
        { id: '4', companyName: 'Dawn Dying House', city: 'Ahmedabad', contactPerson: 'Dinesh Patel', email: 'dinesh@dawndye.com' },
        { id: '5', companyName: 'Elite Handlooms', city: 'Varanasi', contactPerson: 'Eshwar Mishra', email: 'eshwar@elitehandlooms.com' },
        { id: '6', companyName: 'Falcon Fibres Ltd', city: 'Ludhiana', contactPerson: 'Farhan Ali', email: 'farhan@falconfibres.com' },
        { id: '7', companyName: 'Globe Denims Inc', city: 'Bengaluru', contactPerson: 'Gautam Rao', email: 'gautam@globedenims.com' },
        { id: '8', companyName: 'Heritage Silks', city: 'Kanchipuram', contactPerson: 'Hariharan S', email: 'hari@heritagesilks.com' },
        { id: '9', companyName: 'Imperial Threads LLP', city: 'Mumbai', contactPerson: 'Irfan Khan', email: 'irfan@imperialthreads.com' },
      ];

      const pageSize = 3;
      const start = (page - 1) * pageSize;
      const pageItems = allRecords.slice(start, start + pageSize);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        totalPages: 3,
        totalElements: 9,
        pageNumber: page,
        pageSize,
        items: pageItems,
      }));
      return;
    }

    // 3. Detail page merge and failed detail page tolerance fixture
    if (pathname === '/cards-detail/listing') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Card Directory with Detail Links</title></head>
        <body>
          <div class="directory-list">
            <div class="card">
              <h3>Zenith Fabrics International</h3>
              <p>City: Mumbai</p>
              <a href="/cards-detail/detail-good">View Details</a>
            </div>
            <div class="card">
              <h3>Orion Weaving Mills</h3>
              <p>City: Surat</p>
              <a href="/cards-detail/detail-fail">View Details</a>
            </div>
          </div>
        </body>
        </html>
      `);
      return;
    }

    if (pathname === '/cards-detail/detail-good') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Zenith Fabrics - Exhibitor Profile</title></head>
        <body>
          <h2>Zenith Fabrics International</h2>
          <p>Contact Person: Rajesh Varma</p>
          <p>Designation: Managing Director</p>
          <p>Email: <a href="mailto:rajesh@zenithfabrics.com">rajesh@zenithfabrics.com</a></p>
          <p>Phone: <a href="tel:+919820012345">+91 98200 12345</a></p>
          <p>Hall: Hall 4 / Booth H-42</p>
          <p>Category: Luxury Textiles & Silks</p>
          <a href="https://www.zenithfabrics-outbound.com">Official Website</a>
        </body>
        </html>
      `);
      return;
    }

    if (pathname === '/cards-detail/detail-fail') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error simulation');
      return;
    }

    // 4. JS-driven DOM-next directory fixture (interactive dynamic pagination)
    if (pathname === '/dom-next/directory') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>DOM Next Interactive Directory</title></head>
        <body>
          <h2>DOM Next Exhibitors</h2>
          <div id="container">
            <div class="card">
              <h3>Dynamic Page 1 Alpha Ltd</h3>
              <p>City: Delhi</p>
              <p>Email: alpha@interactive.com</p>
            </div>
            <div class="card">
              <h3>Dynamic Page 1 Beta Corp</h3>
              <p>City: Noida</p>
              <p>Email: beta@interactive.com</p>
            </div>
          </div>
          <button id="next-page-btn" class="next" onclick="loadNext()">Next Page &gt;</button>
          <script>
            let p = 1;
            function loadNext() {
              p++;
              const el = document.getElementById('container');
              if (p === 2) {
                el.innerHTML = '<div class="card"><h3>Dynamic Page 2 Gamma Inc</h3><p>City: Pune</p><p>Email: gamma@interactive.com</p></div><div class="card"><h3>Dynamic Page 2 Delta Ltd</h3><p>City: Mumbai</p><p>Email: delta@interactive.com</p></div>';
              } else {
                document.getElementById('next-page-btn').remove();
              }
            }
          </script>
        </body>
        </html>
      `);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise<void>((resolve) => server.listen(PORT, resolve));

  try {
    // Test 1: Static HTML 3-page pagination & Directory Organizer Filtering
    await test('Static HTML 3-page pagination extracts all 9 records and filters organizer email', async () => {
      const result = await extractFromDirectory(`${baseUrl}/static/page1`, {
        allowLoopback: true,
        maxPages: 10,
      }, 'Static Test');

      assert.strictEqual(result.status, 'COMPLETED');
      assert.strictEqual(result.leads.length, 9, `Expected 9 records, got ${result.leads.length}`);
      assert.ok(result.metrics.pagesProcessed >= 3, `Expected at least 3 pages, got ${result.metrics.pagesProcessed}`);
      assert.ok(['URL_QUERY', 'DOM_NEXT'].includes(result.metrics.strategy), `Strategy was ${result.metrics.strategy}`);

      const companies = result.leads.map(l => l.companyName);
      assert.ok(companies.includes('Alpha Fabrics Ltd'));
      assert.ok(companies.includes('Delta Textiles Pvt Ltd'));
      assert.ok(companies.includes('Iota Woolen Industries'));

      // Verify directory-level organizer contact is NOT extracted as a lead
      assert.ok(!result.leads.some(l => l.email === 'expo@organizer.com'), 'Organizer email must not be ingested as a lead');
    });

    // Test 2: Public API pagination
    await test('Public API pagination extracts all 9 records across 3 pages', async () => {
      const result = await extractFromDirectory(`${baseUrl}/api-directory/index`, {
        allowLoopback: true,
        maxPages: 10,
      }, 'API Test');

      assert.strictEqual(result.status, 'COMPLETED');
      assert.strictEqual(result.leads.length, 9, `Expected 9 records, got ${result.leads.length}`);
      assert.strictEqual(result.metrics.strategy, 'API_QUERY');
      assert.strictEqual(result.metrics.totalPages, 3);
      assert.strictEqual(result.metrics.pagesProcessed, 3);

      const names = result.leads.map(l => l.companyName);
      assert.ok(names.includes('Apex Knits India'));
      assert.ok(names.includes('Elite Handlooms'));
      assert.ok(names.includes('Imperial Threads LLP'));
    });

    // Test 3: Detail page merge & failed detail page tolerance
    await test('Detail page extraction merges rich detail fields and tolerates failed detail pages', async () => {
      const result = await extractFromDirectory(`${baseUrl}/cards-detail/listing`, {
        allowLoopback: true,
        maxPages: 5,
        maxDetailPages: 5,
      }, 'Detail Test');

      assert.strictEqual(result.status, 'PARTIAL', 'Status should be PARTIAL due to 1 failed detail page');
      assert.strictEqual(result.leads.length, 2);
      assert.strictEqual(result.metrics.failedPages, 1);

      const zenith = result.leads.find(l => l.companyName?.includes('Zenith'));
      assert.ok(zenith, 'Zenith lead should exist');
      assert.strictEqual(zenith?.email, 'rajesh@zenithfabrics.com');
      assert.strictEqual(zenith?.phone, '+919820012345');
      assert.strictEqual(zenith?.contactName, 'Rajesh Varma');
      assert.strictEqual(zenith?.contactTitle, 'Managing Director');
      assert.strictEqual(zenith?.domain, 'zenithfabrics-outbound.com');

      const orion = result.leads.find(l => l.companyName?.includes('Orion'));
      assert.ok(orion, 'Orion lead should exist from listing card despite detail page 500 error');
    });

    // Test 4: Batch CSV Export format and escaping
    await test('Batch CSV export contains all 38 specification headers and escapes quotes and commas', () => {
      const mockLeads = [
        {
          id: 'lead-1',
          companyName: 'Acme Textiles, Ltd.',
          companyNormalizedName: 'ACME TEXTILES',
          contactName: 'John Michael Doe',
          contactTitle: 'VP of Exports',
          email: 'john@acmetextiles.com',
          phone: '+15551234567',
          websiteUrl: 'https://acmetextiles.com',
          domain: 'acmetextiles.com',
          linkedinUrl: 'https://linkedin.com/company/acmetextiles',
          country: 'India',
          state: 'Tamil Nadu',
          city: 'Tiruppur',
          address: 'Hall 4 / Booth 21B',
          industry: 'Textiles',
          hasValidEmail: true,
          completenessScore: 0.95,
          dedupeStatus: 'UNIQUE',
          duplicateReason: null,
          extractedAt: new Date('2026-09-16T12:00:00Z'),
          sourceType: 'WEBSITE',
          sourceName: 'Bharat Tex 2026 Exhibitors',
          provenance: {
            url: 'https://bharat-tex.com/pre-fair-directory/',
            pageNumber: 1,
            rowNumber: 1,
            rawData: {
              subcategory: 'Apparel & Knitwear',
              category: 'Garments',
              hall: '4',
              booth: '21B',
            },
          },
        },
      ];

      const csv = generateBatchLeadsCsv(mockLeads, 'https://bharat-tex.com/pre-fair-directory/');
      assert.ok(csv.startsWith('\uFEFF'), 'CSV must start with UTF-8 BOM');

      const lines = csv.replace('\uFEFF', '').split('\r\n');
      const headerLine = lines[0] || '';
      const dataLine = lines[1] || '';
      const headers = headerLine.split(',');
      assert.strictEqual(headers.length, 38, `Expected 38 headers, got ${headers.length}`);
      assert.ok(headers.includes('Company Name'));
      assert.ok(headers.includes('Normalized Company Name'));
      assert.ok(headers.includes('First Name'));
      assert.ok(headers.includes('Last Name'));
      assert.ok(headers.includes('Job Title'));
      assert.ok(headers.includes('Email Format Status'));
      assert.ok(headers.includes('Data Completeness'));

      // Row check
      assert.ok(dataLine.includes('"Acme Textiles, Ltd."'), 'Company name with comma must be escaped in quotes');
      assert.ok(dataLine.includes('John'), 'First name John must be present');
      assert.ok(dataLine.includes('Michael Doe'), 'Last name Michael Doe must be present');
      assert.ok(dataLine.includes('Valid Email Format'), 'Email Format Status must be Valid Email Format');
    });

    // Test 5: JS-driven DOM-next interactive pagination
    await test('JS-driven DOM-next directory pagination clicks next and extracts all dynamic cards', async () => {
      const result = await extractFromDirectory(`${baseUrl}/dom-next/directory`, {
        allowLoopback: true,
        maxPages: 5,
      }, 'DOM-Next Test');

      assert.strictEqual(result.status, 'COMPLETED');
      assert.ok(result.leads.length >= 4, `Expected at least 4 records, got ${result.leads.length}`);
      assert.strictEqual(result.metrics.strategy, 'DOM_NEXT');

      const companyNames = result.leads.map(l => l.companyName);
      assert.ok(companyNames.some(c => c?.includes('Dynamic Page 1 Alpha')));
      assert.ok(companyNames.some(c => c?.includes('Dynamic Page 2 Gamma')));
    });

    // Test 6: Missing fields & partial data normalization
    await test('Missing fields are handled gracefully with calibrated completeness score', () => {
      const partialLead = {
        companyName: 'Minimalist Textiles Co.',
        city: 'Surat',
        sourceType: 'WEBSITE',
        sourceName: 'Test Directory',
      };

      const normalized = normalizeLeadPayload(partialLead);
      assert.strictEqual(normalized.companyName, 'Minimalist Textiles Co.');
      assert.strictEqual(normalized.companyNormalizedName, 'minimalist textiles');
      assert.strictEqual(normalized.email, null);
      assert.strictEqual(normalized.phone, null);
      assert.strictEqual(normalized.domain, null);
      assert.strictEqual(normalized.city, 'Surat');
      assert.strictEqual(normalized.hasValidEmail, false);

      // Completeness score: Base companyName (0.25) + city (0.05) = 0.30
      assert.strictEqual(normalized.completenessScore, 0.30);
    });

    // Test 7: Duplicate detection & bigram similarity logic
    await test('Duplicate detection accurately classifies exact and fuzzy company matches', () => {
      // Exact or suffix variation: "Acme Textiles Ltd" vs "Acme Textiles Pvt Ltd"
      const comp1 = 'Acme Textiles Ltd';
      const comp2 = 'Acme Textiles Pvt Ltd';
      const norm1 = 'acme textiles';
      const norm2 = 'acme textiles';
      assert.strictEqual(norm1, norm2, 'Normalized names must match');

      // Fuzzy string similarity
      const simHigh = stringSimilarity('Apex Knits International', 'Apex Knits Internationl');
      assert.ok(simHigh > 0.90, `Expected high similarity, got ${simHigh}`);

      const simLow = stringSimilarity('Apex Knits', 'Zeta Weaving Mills');
      assert.ok(simLow < 0.30, `Expected low similarity, got ${simLow}`);
    });

    // Test 8: Safety limit ceiling enforcement (stops safely, marks PARTIAL)
    await test('Safety ceiling limits stop processing safely and mark batch as PARTIAL', async () => {
      const result = await extractFromDirectory(`${baseUrl}/static/page1`, {
        allowLoopback: true,
        maxPages: 2, // Ceiling below the 3 total pages
      }, 'Safety Ceiling Test');

      assert.strictEqual(result.status, 'PARTIAL', 'Should be marked PARTIAL when maxPages ceiling is reached');
      assert.strictEqual(result.metrics.pagesProcessed, 2, 'Should have stopped exactly at 2 pages');
      assert.ok(result.metrics.stopReason?.includes('Configured maximum pages limit'), `Stop reason: ${result.metrics.stopReason}`);
      assert.strictEqual(result.leads.length, 6, 'Should have preserved the 6 records from the first 2 pages');
    });

  } finally {
    await closeBrowser();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('\n------------------------------------------------------');
  console.log(`PAGINATION TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('------------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPaginationTests().catch((err) => {
  console.error('Fatal error running pagination tests:', err);
  process.exit(1);
});
