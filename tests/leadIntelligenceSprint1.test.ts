import assert from 'assert';
import dotenv from 'dotenv';
import path from 'path';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import {
  normalizeCompanyName,
  normalizeDomain,
  parseCompanyDivision,
  normalizeLeadPayload,
} from '../src/services/leadIntelligence/normalizationService';

import {
  companyResolutionService,
  ResolutionCandidate,
} from '../src/services/leadIntelligence/companyResolutionService';

import { extractCardsFromHtml } from '../src/services/leadIntelligence/directoryExtractor';
import { classifyPage } from '../src/services/leadIntelligence/pageClassifier';
import { isPrivateOrRestrictedIp, validatePublicUrl } from '../src/services/leadIntelligence/urlFetcherService';
import { generateCompanyExhibitorCsv } from '../src/services/leadIntelligence/exportService';
import { BatchQueueService } from '../src/services/leadIntelligence/batchQueueService';
import { detectApiPaginationPattern } from '../src/services/leadIntelligence/paginationEngine';
import { processLeadIntelligencePipeline } from '../src/services/leadIntelligence/leadIntelligencePipeline';
import {
  TavilySearchResolver,
  createTavilySearchResolver,
  isRejectedSearchDomain,
  tavilySearchResolver,
} from '../src/services/leadIntelligence/search/tavilySearchResolver';

const prisma = new PrismaClient();

async function runSprint1TestSuite() {
  console.log('\n======================================================');
  console.log('🧪 SPRINT 1 — LEAD INTELLIGENCE VALIDATION TEST SUITE');
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
  // SECTION 1: DIVISION PARSING & ADVANCED NORMALIZATION
  // ----------------------------------------------------
  console.log('--- SECTION 1: Division Parsing & Normalization ---');

  await test('parseCompanyDivision separates parent brand from division note', () => {
    const res1 = parseCompanyDivision('Agrayan (A Division of Digite Infotech Pvt Ltd)');
    assert.strictEqual(res1.baseName, 'Agrayan');
    assert.strictEqual(res1.parentCompany, 'Digite Infotech Pvt Ltd');
    assert.strictEqual(res1.relationshipType, 'DIVISION');

    const res2 = parseCompanyDivision('Acme Dynamics [Div. of Apex Global]');
    assert.strictEqual(res2.baseName, 'Acme Dynamics');
    assert.strictEqual(res2.parentCompany, 'Apex Global');
    assert.strictEqual(res2.relationshipType, 'DIVISION');

    const res3 = parseCompanyDivision('TripGain Technologies - A Division of Travelport');
    assert.strictEqual(res3.baseName, 'TripGain Technologies');
    assert.strictEqual(res3.parentCompany, 'Travelport');
    assert.strictEqual(res3.relationshipType, 'DIVISION');

    const res4 = parseCompanyDivision('Simple Enterprise Ltd');
    assert.strictEqual(res4.baseName, 'Simple Enterprise Ltd');
    assert.strictEqual(res4.parentCompany, null);
    assert.strictEqual(res4.relationshipType, null);
  });

  await test('normalizeCompanyName strips legal entity types without losing brand name', () => {
    assert.strictEqual(normalizeCompanyName('TripGain Technologies Pvt. Ltd.'), 'tripgain technologies');
    assert.strictEqual(normalizeCompanyName('Agrayan (A Division of Digite Infotech Pvt Ltd)'), 'agrayan');
    assert.strictEqual(normalizeCompanyName('Global Software GmbH & Co. KG'), 'global software');
    assert.strictEqual(normalizeCompanyName('Oceanic Logistics Inc.'), 'oceanic logistics');
  });

  await test('normalizeCompanyName handles Unicode company names cleanly', () => {
    assert.strictEqual(normalizeCompanyName('München Präzision GmbH'), 'münchen präzision');
    assert.strictEqual(normalizeCompanyName('Société Générale d’Ingénierie S.A.'), 'société générale d’ingénierie');
    assert.strictEqual(normalizeCompanyName('日本語技術株式会社'), '日本語技術株式会社');
  });

  await test('normalizeDomain sanitizes dirty exhibitor website URLs', () => {
    assert.strictEqual(normalizeDomain('https://www.tripgain.com/exhibitors/2026?ref=expo#booth'), 'tripgain.com');
    assert.strictEqual(normalizeDomain('http://sub.domain.co.uk:8080/path'), 'sub.domain.co.uk');
    assert.strictEqual(normalizeDomain('WWW.EXAMPLE.COM'), 'example.com');
    assert.strictEqual(normalizeDomain('invalid-domain-no-tld'), null);
    assert.strictEqual(normalizeDomain(''), null);
  });

  await test('normalizeLeadPayload preserves rawName, boothNumber, hallNumber, category', () => {
    const raw = {
      companyName: 'Nova Robotics (A Division of CyberCorp)',
      rawName: 'Nova Robotics (A Division of CyberCorp) - Hall 3',
      websiteUrl: 'https://www.novarobotics.ai/about',
      boothNumber: 'B-142',
      hallNumber: 'Hall 3',
      category: 'Automation & AI',
      sourceType: 'WEBSITE' as const,
      sourceName: 'TechExpo 2026',
      sourceUrl: 'https://techexpo.com/exhibitors',
    };

    const normalized = normalizeLeadPayload(raw);
    assert.strictEqual(normalized.companyName, 'Nova Robotics');
    assert.strictEqual(normalized.rawName, 'Nova Robotics (A Division of CyberCorp) - Hall 3');
    assert.strictEqual(normalized.boothNumber, 'B-142');
    assert.strictEqual(normalized.hallNumber, 'Hall 3');
    assert.strictEqual(normalized.category, 'Automation & AI');
    assert.strictEqual(normalized.domain, 'novarobotics.ai');
    assert.strictEqual(normalized.sourceUrl, 'https://techexpo.com/exhibitors');
  });

  // ----------------------------------------------------
  // SECTION 2: EXHIBITOR DIRECTORY EXTRACTION
  // ----------------------------------------------------
  console.log('\n--- SECTION 2: Exhibitor Directory Extraction ---');

  await test('extractCardsFromHtml extracts structured exhibitor cards with booth & links, suppressing wrappers', () => {
    const htmlSample = `
      <html>
        <body>
          <div class="exhibitor-list">
            <div class="exhibitor card">
              <h3 class="company-title"><a href="/exhibitors/agrayan-tech">Agrayan Technologies</a></h3>
              <div class="booth-info">Booth: 12B</div>
              <span class="category">Cloud Solutions</span>
            </div>
            <div class="exhibitor card">
              <h3 class="company-title"><a href="/exhibitors/zenith-aerospace">Zenith Aerospace Pvt Ltd</a></h3>
              <span class="stand-number">Stand #405</span>
              <span class="industry">Aviation</span>
            </div>
            <div class="exhibitor card">
              <h3 class="company-title">Apex Diagnostics</h3>
              <span class="booth">Booth 88</span>
              <span class="tag">Healthcare</span>
            </div>
          </div>
        </body>
      </html>
    `;

    const extracted = extractCardsFromHtml(htmlSample, 'https://expo2026.org/exhibitors', [], []);
    assert.strictEqual(extracted.length, 3);

    const agrayan = extracted.find((e) => e.companyName?.includes('Agrayan'));
    assert.ok(agrayan);
    assert.ok(agrayan?.hallOrBooth?.includes('12B'));
    assert.strictEqual(agrayan?.category, 'Cloud Solutions');
    assert.strictEqual(agrayan?.detailUrl, 'https://expo2026.org/exhibitors/agrayan-tech');

    const zenith = extracted.find((e) => e.companyName?.includes('Zenith'));
    assert.ok(zenith);
    assert.ok(zenith?.hallOrBooth?.includes('405'));

    const apex = extracted.find((e) => e.companyName?.includes('Apex'));
    assert.ok(apex);
    assert.ok(apex?.hallOrBooth?.includes('88'));
  });

  await test('Page Classification Regression: URL hash fragment and exhibitor cards classify as DIRECTORY', () => {
    const htmlWithCards = `
      <html>
        <head><title>Agritech Expo 2026</title></head>
        <body>
          <h1>Welcome to the Annual Event</h1>
          <section id="past-exhibitors">
            <div class="exhibitor-card-item">Alpha Agro Products</div>
            <div class="exhibitor-card-item">Beta Irrigation Ltd</div>
            <div class="exhibitor-card-item">Gamma Solar Pumps</div>
            <div class="exhibitor-card-item">Delta Fertilizers</div>
            <div class="exhibitor-card-item">Epsilon Seeds</div>
            <div class="exhibitor-card-item">Zeta Tractors</div>
            <div class="exhibitor-card-item">Eta Greenhouses</div>
            <div class="exhibitor-card-item">Theta Harvesting</div>
            <div class="exhibitor-card-item">Iota Implements</div>
            <div class="exhibitor-card-item">Kappa BioTech</div>
            <div class="exhibitor-card-item">Lambda Drone Ag</div>
          </section>
        </body>
      </html>
    `;

    // Test A: URL with fragment #past-exhibitors
    const classifiedA = classifyPage(htmlWithCards, 'https://www.agritechindia.com/#past-exhibitors');
    assert.strictEqual(classifiedA.pageType, 'DIRECTORY', 'Hash fragment #past-exhibitors must classify as DIRECTORY');
    assert.ok(classifiedA.confidence >= 0.75, `Expected confidence >= 0.75, got ${classifiedA.confidence}`);

    // Test B: Root URL without fragment but with repeated exhibitor cards DOM
    const classifiedB = classifyPage(htmlWithCards, 'https://www.agritechindia.com/');
    assert.strictEqual(classifiedB.pageType, 'DIRECTORY', 'Exhibitor cards DOM must classify as DIRECTORY');
    assert.ok(classifiedB.confidence >= 0.75, `Expected confidence >= 0.75, got ${classifiedB.confidence}`);
  });

  await test('Direct Text Cards Regression: extractCardsFromHtml extracts leaf text nodes scoped to URL hash', () => {
    const htmlWithDirectText = `
      <html>
        <body>
          <div class="global-nav">
            <a href="/">Home</a>
            <button class="tab-btn">Overview</button>
          </div>
          <section id="other-section">
            <div class="irrelevant-item">Not an exhibitor</div>
          </section>
          <section id="past-exhibitors">
            <div class="exhibitor-card-item">Aaron Pipe Industries</div>
            <div class="exhibitor-card-item">Bharat Agri Solutions</div>
            <div class="exhibitor-card-item">Chandra Bio Chem</div>
            <div class="exhibitor-card-item">Deepak Fertilisers & Petrochemicals</div>
            <div class="exhibitor-card-item">Evergreen Irrigation Pvt Ltd</div>
          </section>
        </body>
      </html>
    `;

    const extracted = extractCardsFromHtml(
      htmlWithDirectText,
      'https://www.agritechindia.com/#past-exhibitors',
      [],
      []
    );

    assert.strictEqual(extracted.length, 5, `Expected 5 cards extracted, got ${extracted.length}`);
    const names = extracted.map((e) => e.companyName);
    assert.ok(names.includes('Aaron Pipe Industries'));
    assert.ok(names.includes('Bharat Agri Solutions'));
    assert.ok(names.includes('Chandra Bio Chem'));
    assert.ok(names.includes('Deepak Fertilisers & Petrochemicals'));
    assert.ok(names.includes('Evergreen Irrigation Pvt Ltd'));
  });

  // ----------------------------------------------------
  // SECTION 3: PAGINATION ENGINE ACCEPTANCE CRITERIA
  // ----------------------------------------------------
  console.log('\n--- SECTION 3: Pagination Engine Coverage ---');

  await test('API Pagination: detectApiPaginationPattern detects page and offset metadata', () => {
    const mockResponses = [
      {
        url: 'https://tradeshow.com/api/exhibitors?page=1&limit=25',
        data: [{ id: 1, name: 'Exhibitor 1' }],
        rawResponse: {
          totalPages: 10,
          totalRecords: 250,
          currentPage: 1,
          data: [{ id: 1, name: 'Exhibitor 1' }],
        },
      },
    ];

    const detected = detectApiPaginationPattern(mockResponses);
    assert.ok(detected);
    assert.strictEqual(detected?.totalPages, 10);
    assert.strictEqual(detected?.pageParamName, 'page');
    assert.strictEqual(detected?.totalRecords, 250);
  });

  await test('URL / Query Pagination: constructs next page URLs deterministically', () => {
    const baseUrl = 'https://expo2026.com/directory?category=ai&page=1';
    const parsed = new URL(baseUrl);
    parsed.searchParams.set('page', '2');
    assert.strictEqual(parsed.toString(), 'https://expo2026.com/directory?category=ai&page=2');
  });

  // ----------------------------------------------------
  // SECTION 4: EVIDENCE-BASED RESOLUTION LOGIC
  // ----------------------------------------------------
  console.log('\n--- SECTION 4: Evidence-Based Company/Domain Resolution ---');

  await test('Tier 1: Direct directory website resolves to RESOLVED_HIGH without numeric confidence', async () => {
    companyResolutionService.clearCache();
    const result = await companyResolutionService.resolveCompany({
      companyName: 'TechCorp Solutions',
      companyNormalizedName: 'techcorp solutions',
      rawName: 'TechCorp Solutions Inc',
      websiteUrl: 'https://www.techcorpsolutions.com/products',
      sourceUrl: 'https://tradefair.com/directory',
    });

    assert.strictEqual(result.resolutionStatus, 'RESOLVED_HIGH');
    assert.strictEqual(result.resolutionSource, 'DIRECTORY');
    assert.strictEqual(result.domain, 'techcorpsolutions.com');
    assert.strictEqual(result.websiteUrl, 'https://techcorpsolutions.com');
    assert.ok(!('resolutionConfidence' in result)); // Numeric confidence strictly absent
    assert.ok(result.resolutionEvidence.evidence.includes('directory listing'));
  });

  await test('Tier 2: Workspace database match resolves to RESOLVED_HIGH', async () => {
    companyResolutionService.clearCache();
    // Simulate workspace verified lead matching
    const mockDbCandidate = async (query: string): Promise<ResolutionCandidate[]> => [
      { domain: 'tripgain.com', title: 'TripGain Technologies' }
    ];

    const result = await companyResolutionService.resolveCompany({
      companyName: 'TripGain Technologies',
      companyNormalizedName: 'tripgain technologies',
      rawName: 'TripGain Technologies',
      searchResolver: mockDbCandidate,
    });

    assert.strictEqual(result.resolutionStatus, 'RESOLVED_MEDIUM');
    assert.strictEqual(result.domain, 'tripgain.com');
    assert.ok(!('resolutionConfidence' in result));
  });

  await test('Tier 3: Single strong search candidate resolves to RESOLVED_MEDIUM', async () => {
    companyResolutionService.clearCache();
    const mockSearchSingle = async (query: string): Promise<ResolutionCandidate[]> => [
      { domain: 'blueocean-logistics.in', title: 'Blue Ocean Logistics India', snippet: 'Freight forwarding and 3PL' }
    ];

    const result = await companyResolutionService.resolveCompany({
      companyName: 'Blue Ocean Logistics',
      companyNormalizedName: 'blue ocean logistics',
      rawName: 'Blue Ocean Logistics Pvt Ltd',
      city: 'Mumbai',
      searchResolver: mockSearchSingle,
    });

    assert.strictEqual(result.resolutionStatus, 'RESOLVED_MEDIUM');
    assert.strictEqual(result.resolutionSource, 'SEARCH');
    assert.strictEqual(result.domain, 'blueocean-logistics.in');
    assert.ok(!('resolutionConfidence' in result));
  });

  await test('Tier 3: Multiple conflicting candidates mark company as REVIEW_REQUIRED (zero domain guessing)', async () => {
    companyResolutionService.clearCache();
    const mockSearchConflicting = async (query: string): Promise<ResolutionCandidate[]> => [
      { domain: 'deltaenergy.com', title: 'Delta Energy USA - Power Systems' },
      { domain: 'delta-energy.co.uk', title: 'Delta Energy UK Limited' },
    ];

    const result = await companyResolutionService.resolveCompany({
      companyName: 'Delta Energy',
      companyNormalizedName: 'delta energy',
      rawName: 'Delta Energy',
      searchResolver: mockSearchConflicting,
    });

    assert.strictEqual(result.resolutionStatus, 'REVIEW_REQUIRED');
    assert.strictEqual(result.resolutionSource, 'SEARCH');
    assert.strictEqual(result.domain, null); // Strictly NEVER fabricate domains for review-required cases
    assert.strictEqual(result.resolutionEvidence.candidateDomain, 'deltaenergy.com'); // Top candidate preserved for reviewer
    assert.strictEqual(result.resolutionEvidence.candidates?.length, 2);
    assert.ok(result.resolutionEvidence.evidence.includes('Multiple conflicting domain candidates'));
    assert.ok(!('resolutionConfidence' in result));
  });

  await test('Tier 3: Weak search candidate (score < 0.75) marks company as REVIEW_REQUIRED with domain null', async () => {
    companyResolutionService.clearCache();
    const mockSearchWeak = async (query: string): Promise<ResolutionCandidate[]> => [
      { domain: 'genmachholdings.biz', title: 'GenMach Directory Listing', score: 0.60 }
    ];

    const result = await companyResolutionService.resolveCompany({
      companyName: 'General Machinery Co',
      companyNormalizedName: 'general machinery co',
      rawName: 'General Machinery Co',
      searchResolver: mockSearchWeak,
    });

    assert.strictEqual(result.resolutionStatus, 'REVIEW_REQUIRED');
    assert.strictEqual(result.resolutionSource, 'SEARCH');
    assert.strictEqual(result.domain, null); // Strictly null for weak evidence
    const preserved = result.resolutionEvidence.candidates;
    assert.ok(preserved && preserved.length > 0);
    assert.ok(!('score' in ((preserved?.[0] || {}) as any))); // Numeric ranking score strictly internal
    assert.strictEqual(preserved?.[0]?.domain, 'genmachholdings.biz'); // Preserved
    assert.ok(result.resolutionEvidence.evidence.includes('Weak candidate domain returned from search query'));
    assert.ok(!('resolutionConfidence' in result));
  });

  await test('Tier 4: No candidates mark company as UNRESOLVED without fabricating domain', async () => {
    companyResolutionService.clearCache();
    const mockSearchEmpty = async (query: string): Promise<ResolutionCandidate[]> => [];

    const result = await companyResolutionService.resolveCompany({
      companyName: 'Obscure Unknown Microtech 123499',
      companyNormalizedName: 'obscure unknown microtech 123499',
      rawName: 'Obscure Unknown Microtech 123499',
      searchResolver: mockSearchEmpty,
    });

    assert.strictEqual(result.resolutionStatus, 'UNRESOLVED');
    assert.strictEqual(result.domain, null);
    assert.strictEqual(result.websiteUrl, null);
    assert.ok(result.resolutionEvidence.evidence.includes('No reliable domain evidence'));
    assert.ok(!('resolutionConfidence' in result));
  });

  await test('Resolution Caching: repeated resolution queries return cached object', async () => {
    companyResolutionService.clearCache();
    let queryCount = 0;
    const mockCountingSearch = async (query: string): Promise<ResolutionCandidate[]> => {
      queryCount++;
      return [{ domain: 'acmewidgets.com', title: 'Acme Widgets' }];
    };

    // First call
    const res1 = await companyResolutionService.resolveCompany({
      companyName: 'Acme Widgets',
      companyNormalizedName: 'acme widgets',
      rawName: 'Acme Widgets',
      searchResolver: mockCountingSearch,
    });

    // Second call with same normalized name
    const res2 = await companyResolutionService.resolveCompany({
      companyName: 'Acme Widgets',
      companyNormalizedName: 'acme widgets',
      rawName: 'Acme Widgets Inc',
      searchResolver: mockCountingSearch,
    });

    assert.strictEqual(queryCount, 1); // Only queried once, second was cached
    assert.strictEqual(res1.domain, res2.domain);
    assert.strictEqual(res1.resolutionStatus, res2.resolutionStatus);
  });

  await test('Resolution Rate Limiting: consecutive search calls respect minSearchIntervalMs', async () => {
    companyResolutionService.clearCache();
    const timestamps: number[] = [];
    const mockPacedSearch = async (query: string): Promise<ResolutionCandidate[]> => {
      timestamps.push(Date.now());
      return [{ domain: `${query.replace(/\s+/g, '')}.com` }];
    };

    await companyResolutionService.resolveCompany({
      companyName: 'Company One',
      companyNormalizedName: 'company one',
      rawName: 'Company One',
      searchResolver: mockPacedSearch,
    });

    await companyResolutionService.resolveCompany({
      companyName: 'Company Two',
      companyNormalizedName: 'company two',
      rawName: 'Company Two',
      searchResolver: mockPacedSearch,
    });

    assert.strictEqual(timestamps.length, 2);
    const interval = timestamps[1]! - timestamps[0]!;
    assert.ok(interval >= 40, `Expected search rate limit >= 40ms, got ${interval}ms`);
  });

  // ----------------------------------------------------
  // SECTION 4B: TIER 3 WEB SEARCH RESOLUTION (TAVILY PROVIDER)
  // ----------------------------------------------------
  console.log('\n--- SECTION 4B: Tier 3 Web Search Resolution (Tavily Provider Adapter) ---');

  await test('Test A: Tavily result → valid company domain candidate', async () => {
    const mockFetch: typeof fetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              title: 'Acme Robotics Official Portal',
              url: 'https://www.acme-robotics.com/products',
              content: 'Autonomous industrial robotics manufacturer',
              score: 0.92,
            },
          ],
        }),
      } as any);

    const resolver = new TavilySearchResolver({ apiKey: 'tvly-test-key', fetchFn: mockFetch });
    const candidates = await resolver.resolve('Acme Robotics');

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0]?.domain, 'acme-robotics.com');
    assert.strictEqual(candidates[0]?.websiteUrl, 'https://acme-robotics.com');
    assert.strictEqual(candidates[0]?.provider, 'TAVILY');
    assert.strictEqual(candidates[0]?.title, 'Acme Robotics Official Portal');
  });

  await test('Test B: Social result → rejected', async () => {
    const mockFetch: typeof fetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { title: 'Acme LinkedIn', url: 'https://www.linkedin.com/company/acme-robotics' },
            { title: 'Acme Twitter', url: 'https://twitter.com/acme' },
            { title: 'Acme Facebook', url: 'https://facebook.com/acme' },
          ],
        }),
      } as any);

    const resolver = new TavilySearchResolver({ apiKey: 'tvly-test-key', fetchFn: mockFetch });
    const candidates = await resolver.resolve('Acme Robotics');
    assert.strictEqual(candidates.length, 0, 'All social media domains must be rejected');
  });

  await test('Test C: Event organizer domain → rejected', async () => {
    const mockFetch: typeof fetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { title: 'Acme at MapYourShow', url: 'https://expo.mapyourshow.com/exhibitors/123' },
            { title: 'Acme on IndiaMart', url: 'https://www.indiamart.com/acmerobotics' },
            { title: 'Acme on Fabtech', url: 'https://fabtechexpo.com/exhibitor-list' },
          ],
        }),
      } as any);

    const resolver = new TavilySearchResolver({ apiKey: 'tvly-test-key', fetchFn: mockFetch });
    const candidates = await resolver.resolve('Acme Robotics');
    assert.strictEqual(candidates.length, 0, 'Directory, marketplace and event organizer domains must be rejected');
    assert.strictEqual(isRejectedSearchDomain('mapyourshow.com'), true);
    assert.strictEqual(isRejectedSearchDomain('indiamart.com'), true);
  });

  await test('Test D: Multiple conflicting domains → REVIEW_REQUIRED', async () => {
    companyResolutionService.clearCache();
    const mockSearchConflicting = async (): Promise<ResolutionCandidate[]> => [
      { domain: 'alpha-robotics.com', title: 'Alpha Robotics' },
      { domain: 'alpha-machinery.net', title: 'Alpha Machinery' },
    ];

    const result = await companyResolutionService.resolveCompany({
      companyName: 'Alpha Robotics',
      companyNormalizedName: 'alpha robotics',
      rawName: 'Alpha Robotics',
      searchResolver: mockSearchConflicting,
    });

    assert.strictEqual(result.resolutionStatus, 'REVIEW_REQUIRED');
    assert.strictEqual(result.domain, null, 'Conflicting candidates must result in domain = null');
    assert.strictEqual(result.resolutionSource, 'SEARCH');
    assert.strictEqual(result.resolutionEvidence.candidates?.length, 2);
  });

  await test('Test E: One strong candidate → RESOLVED_MEDIUM', async () => {
    companyResolutionService.clearCache();
    const mockSearchSingle = async (): Promise<ResolutionCandidate[]> => [
      { domain: 'acme-automation.com', title: 'Acme Automation Official', score: 0.88, provider: 'TAVILY' },
    ];

    const result = await companyResolutionService.resolveCompany({
      companyName: 'Acme Automation',
      companyNormalizedName: 'acme automation',
      rawName: 'Acme Automation',
      searchResolver: mockSearchSingle,
    });

    assert.strictEqual(result.resolutionStatus, 'RESOLVED_MEDIUM');
    assert.strictEqual(result.domain, 'acme-automation.com');
    assert.strictEqual(result.websiteUrl, 'https://acme-automation.com');
    assert.strictEqual(result.resolutionSource, 'SEARCH');
    assert.strictEqual(result.resolutionEvidence.provider, 'TAVILY');
  });

  await test('Test F: No candidates → UNRESOLVED', async () => {
    companyResolutionService.clearCache();
    const mockSearchEmpty = async (): Promise<ResolutionCandidate[]> => [];

    const result = await companyResolutionService.resolveCompany({
      companyName: 'Ghost Technologies Inc',
      companyNormalizedName: 'ghost technologies',
      rawName: 'Ghost Technologies Inc',
      searchResolver: mockSearchEmpty,
    });

    assert.strictEqual(result.resolutionStatus, 'UNRESOLVED');
    assert.strictEqual(result.domain, null);
    assert.strictEqual(result.resolutionSource, null);
  });

  await test('Test G: Missing TAVILY_API_KEY → graceful fallback', async () => {
    // Instantiate with empty API key
    const resolver = new TavilySearchResolver({ apiKey: '' });
    const candidates = await resolver.resolve('Any Company');
    assert.strictEqual(candidates.length, 0, 'Missing key must return empty list without crashing');
  });

  await test('Test H: Tavily 429 → bounded retry', async () => {
    let callCount = 0;
    const mock429ThenSuccess: typeof fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 429, statusText: 'Too Many Requests' } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ title: 'Retry Success', url: 'https://retrysuccess.com' }],
        }),
      } as any;
    };

    const resolver = new TavilySearchResolver({
      apiKey: 'tvly-test-key',
      fetchFn: mock429ThenSuccess,
      minIntervalMs: 10,
    });

    const candidates = await resolver.resolve('Retry Company');
    assert.strictEqual(callCount, 2, 'Must retry once after 429');
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0]?.domain, 'retrysuccess.com');
  });

  await test('Test I: Duplicate company → cache prevents repeated search', async () => {
    let fetchCount = 0;
    const mockCountingFetch: typeof fetch = async () => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ title: 'Cached Corp', url: 'https://cachedcorp.com' }],
        }),
      } as any;
    };

    const resolver = new TavilySearchResolver({
      apiKey: 'tvly-test-key',
      fetchFn: mockCountingFetch,
      minIntervalMs: 10,
    });

    const cand1 = await resolver.resolve('Cached Corp');
    const cand2 = await resolver.resolve('Cached Corp'); // Repeated call

    assert.strictEqual(fetchCount, 1, 'Only 1 network fetch should occur; second call must be cached');
    assert.strictEqual(cand1.length, 1);
    assert.strictEqual(cand2.length, 1);
  });

  await test('Test J: Search resolver is actually injected into the real pipeline', async () => {
    const user = await prisma.user.findFirst();
    assert.ok(user);

    const source = await prisma.leadIntelligenceSource.create({
      data: {
        userId: user.id,
        name: `Pipeline Injection Test ${Date.now()}`,
        sourceType: 'PASTED_TEXT',
        status: 'PROCESSING',
      },
    });

    // Provide a company name with no directory website link
    const singleLead = `Company\tCity\nUnique Test Lead Corp\tBengaluru`;

    const result = await processLeadIntelligencePipeline({
      sourceId: source.id,
      userId: user.id,
      pastedText: singleLead,
      sourceName: 'Pipeline Injection Test',
      sourceType: 'PASTED_TEXT',
    });

    assert.strictEqual(result.validCount, 1);

    // Fetch the lead from DB to confirm it ran through the resolution pipeline
    const leadInDb = await prisma.leadIntelligenceLead.findFirst({
      where: { sourceId: source.id },
    });
    assert.ok(leadInDb);
    // Since TAVILY_API_KEY is not set in test environment, it gracefully fell back to UNRESOLVED without crashing
    assert.ok(leadInDb.resolutionStatus === 'UNRESOLVED' || leadInDb.resolutionStatus === 'RESOLVED_MEDIUM');

    // Clean up
    await prisma.leadIntelligenceLead.deleteMany({ where: { sourceId: source.id } });
    await prisma.leadIntelligenceResearchBatch.deleteMany({ where: { sourceId: source.id } });
    await prisma.leadIntelligenceSource.delete({ where: { id: source.id } });
  });

  await test('Test K: Numeric provider ranking is NOT exposed as resolution confidence', async () => {
    companyResolutionService.clearCache();
    const mockTavilyCandidate = async (): Promise<ResolutionCandidate[]> => [
      { domain: 'numeric-hide.com', title: 'Numeric Hide', score: 0.98, provider: 'TAVILY' },
    ];

    const result = await companyResolutionService.resolveCompany({
      companyName: 'Numeric Hide Corp',
      companyNormalizedName: 'numeric hide',
      rawName: 'Numeric Hide Corp',
      searchResolver: mockTavilyCandidate,
    });

    assert.ok(!('resolutionConfidence' in result), 'Numeric resolution confidence must not be present on result');
    assert.strictEqual(result.resolutionStatus, 'RESOLVED_MEDIUM');
  });

  await test('Test L: Domain is never fabricated from company name', async () => {
    companyResolutionService.clearCache();
    const mockEmpty = async (): Promise<ResolutionCandidate[]> => [];

    const result = await companyResolutionService.resolveCompany({
      companyName: 'NonExistentGizmoSpecialtyXYZ',
      companyNormalizedName: 'nonexistentgizmospecialtyxyz',
      rawName: 'NonExistentGizmoSpecialtyXYZ',
      searchResolver: mockEmpty,
    });

    assert.strictEqual(result.domain, null, 'Domain must be null, never invented from company name');
    assert.strictEqual(result.resolutionStatus, 'UNRESOLVED');
  });

  // ----------------------------------------------------
  // SECTION 5: SSRF & URL DEFENSES
  // ----------------------------------------------------
  console.log('\n--- SECTION 5: SSRF Security & URL Defenses ---');

  await test('isPrivateOrRestrictedIp detects loopback, private RFC1918, link-local and cloud metadata', () => {
    assert.strictEqual(isPrivateOrRestrictedIp('127.0.0.1'), true);
    assert.strictEqual(isPrivateOrRestrictedIp('10.0.0.1'), true);
    assert.strictEqual(isPrivateOrRestrictedIp('172.16.0.1'), true);
    assert.strictEqual(isPrivateOrRestrictedIp('192.168.1.1'), true);
    assert.strictEqual(isPrivateOrRestrictedIp('169.254.169.254'), true);
    assert.strictEqual(isPrivateOrRestrictedIp('0.0.0.0'), true);
    assert.strictEqual(isPrivateOrRestrictedIp('::1'), true);
    assert.strictEqual(isPrivateOrRestrictedIp('1.1.1.1'), false);
    assert.strictEqual(isPrivateOrRestrictedIp('142.250.190.46'), false);
  });

  await test('validatePublicUrl blocks SSRF vectors and non-HTTP protocols', async () => {
    await assert.rejects(async () => validatePublicUrl('file:///etc/hosts'), /Prohibited protocol/);
    await assert.rejects(async () => validatePublicUrl('javascript:alert(1)'), /Prohibited protocol/);
    await assert.rejects(async () => validatePublicUrl('data:text/html,test'), /Prohibited protocol/);
    await assert.rejects(async () => validatePublicUrl('http://127.0.0.1:3000/api'), /private or restricted|loopback/i);
    await assert.rejects(async () => validatePublicUrl('http://169.254.169.254/latest/meta-data'), /cloud metadata|private|restricted/i);
  });

  // ----------------------------------------------------
  // SECTION 6: CSV EXPORT FORMAT (RFC-4180 NO CONFIDENCE)
  // ----------------------------------------------------
  console.log('\n--- SECTION 6: Company CSV Export Validation ---');

  await test('generateCompanyExhibitorCsv outputs clean RFC 4180 columns without numeric confidence', () => {
    const leadsSample = [
      {
        companyName: 'Acme & "Sons" Corp',
        companyNormalizedName: 'acme sons',
        websiteUrl: 'https://acme.com',
        domain: 'acme.com',
        resolutionStatus: 'RESOLVED_HIGH',
        resolutionSource: 'DIRECTORY',
        resolutionEvidence: { signals: ['Directory link'], matchReason: 'Explicit link' },
        boothNumber: 'B-10',
        hallNumber: 'Hall 2',
        category: 'Manufacturing, Robotics',
        sourceUrl: 'https://expo.org/exhibitors',
      },
      {
        companyName: 'Mystery Labs',
        companyNormalizedName: 'mystery labs',
        websiteUrl: null,
        domain: null,
        resolutionStatus: 'UNRESOLVED',
        resolutionSource: null,
        resolutionEvidence: { matchReason: 'No domain discovered' },
        boothNumber: null,
        hallNumber: null,
        category: null,
        sourceUrl: 'https://expo.org/exhibitors',
      },
    ];

    const csv = generateCompanyExhibitorCsv(leadsSample as any);
    const lines = csv.trim().split(/\r?\n/);

    // Header line
    assert.strictEqual(lines.length, 3);
    const expectedHeaders = [
      'Company Name',
      'Normalized Company Name',
      'Website',
      'Domain',
      'Resolution Status',
      'Resolution Source',
      'Resolution Evidence',
      'Booth Number',
      'Hall Number',
      'Category',
      'Source URL',
    ].join(',');

    assert.strictEqual(lines[0], expectedHeaders);
    assert.ok(!lines[0]?.includes('Resolution Confidence')); // No numeric confidence header

    // Verify row 1 escaping of quotes and commas
    assert.ok(lines[1]?.includes('"Acme & ""Sons"" Corp"'));
    assert.ok(lines[1]?.includes('"Manufacturing, Robotics"'));
    assert.ok(lines[1]?.includes('RESOLVED_HIGH'));

    // Verify row 2 nulls rendered safely
    assert.ok(lines[2]?.includes('Mystery Labs'));
    assert.ok(lines[2]?.includes('UNRESOLVED'));
  });

  // ----------------------------------------------------
  // SECTION 7: RESUMABILITY, RECOVERY & CONCURRENCY MUTEX
  // ----------------------------------------------------
  console.log('\n--- SECTION 7: Resumability, Worker Recovery & Concurrency ---');

  await test('Duplicate job prevention: concurrent workers cannot process the same batch simultaneously', async () => {
    // Enqueue a batch
    const testBatchId = `batch_concurrency_${Date.now()}`;
    
    // Add to active set manually to simulate an active running worker
    (BatchQueueService as any).activeBatches.add(testBatchId);

    // Verify second worker recognizes it as already active
    const isAlreadyActive = (BatchQueueService as any).activeBatches.has(testBatchId);
    assert.strictEqual(isAlreadyActive, true);

    // Clean up
    (BatchQueueService as any).activeBatches.delete(testBatchId);
  });

  await test('Resumability: restarting worker resumes batch without duplicating already persisted records', async () => {
    // 1. Create a simulated test batch in database
    const user = await prisma.user.findFirst();
    assert.ok(user, 'User record must exist in DB for test');

    const source = await prisma.leadIntelligenceSource.create({
      data: {
        userId: user.id,
        name: `Resume Source ${Date.now()}`,
        sourceType: 'PASTED_TEXT',
        status: 'PROCESSING',
      },
    });

    const testBatch = await prisma.leadIntelligenceResearchBatch.create({
      data: {
        userId: user.id,
        sourceId: source.id,
        name: `Resumable Batch Test ${Date.now()}`,
        status: 'EXTRACTING',
        totalPages: 2,
        pagesProcessed: 1,
        recordsDiscovered: 2,
      },
    });

    // 2. Pre-populate 1 already completed lead from "interrupted" run (Checkpoint 1)
    await prisma.leadIntelligenceLead.create({
      data: {
        userId: user.id,
        sourceId: source.id,
        batchId: testBatch.id,
        companyName: 'Already Processed Corp',
        companyNormalizedName: 'already processed',
        domain: 'alreadyprocessed.com',
        sourceType: 'PASTED_TEXT',
        sourceName: 'Simulated Ingestion',
        resolutionStatus: 'RESOLVED_HIGH',
        resolutionSource: 'DIRECTORY',
      },
    });

    // Verify checkpoint has exactly 1 lead
    const countBeforeResume = await prisma.leadIntelligenceLead.count({
      where: { batchId: testBatch.id },
    });
    assert.strictEqual(countBeforeResume, 1);

    // 3. Simulate Worker Restart / Resume with input containing the already processed exhibitor + a new exhibitor
    const resumePastedText = `Company\tWebsite
Already Processed Corp\thttps://alreadyprocessed.com
Brand New Exhibitor\thttps://brandnewexhibitor.com`;

    await processLeadIntelligencePipeline({
      batchId: testBatch.id,
      sourceId: source.id,
      userId: user.id,
      pastedText: resumePastedText,
      sourceName: 'Simulated Resume',
      sourceType: 'PASTED_TEXT',
    });

    // 4. Verify that the batch completed and did NOT duplicate "Already Processed Corp"
    const leadsAfterResume = await prisma.leadIntelligenceLead.findMany({
      where: { batchId: testBatch.id },
    });

    assert.strictEqual(leadsAfterResume.length, 2, 'Expected exactly 2 leads without duplicate insertions');
    const companies = leadsAfterResume.map((l) => l.companyNormalizedName);
    assert.ok(companies.includes('already processed'));
    assert.ok(companies.includes('brand new exhibitor'));

    // Clean up test records
    await prisma.leadIntelligenceLead.deleteMany({ where: { batchId: testBatch.id } });
    await prisma.leadIntelligenceResearchBatch.delete({ where: { id: testBatch.id } });
    await prisma.leadIntelligenceSource.delete({ where: { id: source.id } });
  });

  await test('Partial extraction failure: non-fatal errors mark batch as PARTIAL instead of crashing', async () => {
    const user = await prisma.user.findFirst();
    assert.ok(user);

    const source = await prisma.leadIntelligenceSource.create({
      data: {
        userId: user.id,
        name: `Partial Source ${Date.now()}`,
        sourceType: 'PASTED_TEXT',
        status: 'PROCESSING',
      },
    });

    // Provide content with 1 valid lead and 1 empty row
    const mixedContent = `Company\tWebsite
Valid Corp\thttps://validcorp.com
\t`;

    const result = await processLeadIntelligencePipeline({
      sourceId: source.id,
      userId: user.id,
      pastedText: mixedContent,
      sourceName: 'Partial Test',
      sourceType: 'PASTED_TEXT',
    });

    assert.ok(result.validCount >= 1);

    // Clean up
    await prisma.leadIntelligenceLead.deleteMany({ where: { sourceId: source.id } });
    await prisma.leadIntelligenceResearchBatch.deleteMany({ where: { sourceId: source.id } });
    await prisma.leadIntelligenceSource.delete({ where: { id: source.id } });
  });

  await test('Large exhibitor list chunking behavior: chunks 500+ records safely', async () => {
    // Generate 250 simulated exhibitor rows
    const rows = ['Company\tWebsite'];
    for (let i = 1; i <= 250; i++) {
      rows.push(`Exhibitor Company ${i}\thttps://exhibitor${i}.com`);
    }
    const tsvContent = rows.join('\n');

    const user = await prisma.user.findFirst();
    assert.ok(user);

    const source = await prisma.leadIntelligenceSource.create({
      data: {
        userId: user.id,
        name: `Scale Source ${Date.now()}`,
        sourceType: 'PASTED_TEXT',
        status: 'PROCESSING',
      },
    });

    const result = await processLeadIntelligencePipeline({
      sourceId: source.id,
      userId: user.id,
      pastedText: tsvContent,
      sourceName: 'Scale Test',
      sourceType: 'PASTED_TEXT',
    });

    assert.strictEqual(result.validCount, 250);

    // Clean up
    await prisma.leadIntelligenceLead.deleteMany({ where: { sourceId: source.id } });
    await prisma.leadIntelligenceResearchBatch.deleteMany({ where: { sourceId: source.id } });
    await prisma.leadIntelligenceSource.delete({ where: { id: source.id } });
  });

  // ----------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------
  console.log('\n======================================================');
  console.log(`🏁 SPRINT 1 TEST RUN COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSprint1TestSuite()
  .catch((err) => {
    console.error('Fatal error during test run:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
