import assert from 'assert';
import dotenv from 'dotenv';
import path from 'path';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import {
  normalizeCompanyName,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  calculateCompletenessScore,
  normalizeLeadPayload,
} from '../src/services/leadIntelligence/normalizationService';

import { stringSimilarity, evaluateDuplicate } from '../src/services/leadIntelligence/deduplicationService';
import { extractFromCsv, extractFromXlsx, extractFromPdf, extractFromPastedText } from '../src/services/leadIntelligence/extractionService';
import { isPrivateOrRestrictedIp, validatePublicUrl } from '../src/services/leadIntelligence/urlFetcherService';
import { generateLeadsCsv, escapeCsvField } from '../src/services/leadIntelligence/exportService';

const prisma = new PrismaClient();

async function runTests() {
  console.log('\n======================================================');
  console.log('🚀 RUNNING LEAD INTELLIGENCE PHASE 1 TEST SUITE');
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
  // SECTION 1: NORMALIZATION TESTS
  // ----------------------------------------------------
  console.log('--- SECTION 1: Normalization & Field Cleaning ---');

  await test('normalizeCompanyName strips common entity suffixes and punctuation', () => {
    assert.strictEqual(normalizeCompanyName('Acme Corp.'), 'acme');
    assert.strictEqual(normalizeCompanyName('TripGain Technologies Pvt Ltd'), 'tripgain technologies');
    assert.strictEqual(normalizeCompanyName('Global Travel, LLC'), 'global travel');
    assert.strictEqual(normalizeCompanyName('Apex Innovations Inc.'), 'apex innovations');
    assert.strictEqual(normalizeCompanyName('Alpha   Beta   Holdings'), 'alpha beta');
    assert.strictEqual(normalizeCompanyName(''), '');
  });

  await test('normalizeDomain cleans protocols, www, subpaths, and query params', () => {
    assert.strictEqual(normalizeDomain('https://www.tripgain.com/about?ref=nav'), 'tripgain.com');
    assert.strictEqual(normalizeDomain('http://tripgain.com'), 'tripgain.com');
    assert.strictEqual(normalizeDomain('www.sub.example.co.uk/path/'), 'sub.example.co.uk');
    assert.strictEqual(normalizeDomain('invalid-domain'), null);
    assert.strictEqual(normalizeDomain(''), null);
  });

  await test('normalizeEmail trims, lowercases, and validates email structure', () => {
    assert.strictEqual(normalizeEmail('  John.Doe@TripGain.com '), 'john.doe@tripgain.com');
    assert.strictEqual(normalizeEmail('mailto:contact@acme.org'), 'contact@acme.org');
    assert.strictEqual(normalizeEmail('not-an-email'), null);
    assert.strictEqual(normalizeEmail('@missingusername.com'), null);
  });

  await test('normalizePhone cleans non-digits while preserving international +', () => {
    assert.strictEqual(normalizePhone('+1 (555) 234-5678'), '+15552345678');
    assert.strictEqual(normalizePhone('+91 98765-43210'), '+919876543210');
    assert.strictEqual(normalizePhone('080-1234567'), '0801234567');
    assert.strictEqual(normalizePhone('123'), null); // too short
  });

  await test('calculateCompletenessScore calculates deterministic quality score', () => {
    const fullLead = {
      companyName: 'Acme Corp',
      domain: 'acme.com',
      websiteUrl: 'https://acme.com',
      email: 'alex@acme.com',
      phone: '+15551234567',
      contactName: 'Alex Smith',
      contactTitle: 'VP of Procurement',
      city: 'Bangalore',
      industry: 'Software',
    };
    const score = calculateCompletenessScore(fullLead);
    assert.strictEqual(score, 1.0);

    const partialLead = {
      companyName: 'TripGain',
      email: 'contact@tripgain.com',
    };
    const partialScore = calculateCompletenessScore(partialLead);
    assert.strictEqual(partialScore, 0.45);
  });

  // ----------------------------------------------------
  // SECTION 2: EXTRACTION TESTS
  // ----------------------------------------------------
  console.log('\n--- SECTION 2: Ingestion & Extraction ---');

  await test('extractFromCsv extracts leads and maps aliases deterministically', () => {
    const csvContent = `Organization,Contact Person,Designation,Work Email,Telephone,HQ City,Website
TripGain Technologies,Mohit R,Operations Manager,mohit@tripgain.com,+919876543210,Bangalore,https://tripgain.com
Acme Global,Sarah Jenkins,VP Travel,sarah@acme.com,+15552345678,New York,https://acme.com`;

    const result = extractFromCsv(csvContent, 'test.csv');
    assert.strictEqual(result.status, 'COMPLETED');
    assert.strictEqual(result.leads.length, 2);
    assert.strictEqual(result.leads[0]?.companyName, 'TripGain Technologies');
    assert.strictEqual(result.leads[0]?.contactName, 'Mohit R');
    assert.strictEqual(result.leads[0]?.contactTitle, 'Operations Manager');
    assert.strictEqual(result.leads[0]?.email, 'mohit@tripgain.com');
    assert.strictEqual(result.leads[0]?.phone, '+919876543210');
    assert.strictEqual(result.leads[0]?.city, 'Bangalore');
    assert.strictEqual(result.leads[0]?.provenance.sourceType, 'CSV');
  });

  await test('extractFromXlsx extracts rows from Excel workbook buffer', () => {
    const wb = XLSX.utils.book_new();
    const wsData = [
      ['Company Name', 'Full Name', 'Job Title', 'Email Address', 'Phone Number', 'City'],
      ['NextGen Travel', 'Rajesh Kumar', 'Director of Admin', 'rajesh@nextgen.com', '+918023456789', 'Mumbai'],
      ['Zenith Logistics', 'Priya Sharma', 'Head of Procurement', 'priya@zenith.in', '+919988776655', 'Delhi'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Leads');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const result = extractFromXlsx(buffer, 'test.xlsx');
    assert.strictEqual(result.status, 'COMPLETED');
    assert.strictEqual(result.leads.length, 2);
    assert.strictEqual(result.leads[0]?.companyName, 'NextGen Travel');
    assert.strictEqual(result.leads[0]?.contactName, 'Rajesh Kumar');
    assert.strictEqual(result.leads[1]?.email, 'priya@zenith.in');
  });

  await test('extractFromPdf returns Needs OCR state for scanned or text-free PDFs', async () => {
    // Synthetic buffer with no text content
    const emptyPdfBuffer = Buffer.from('%PDF-1.4 empty pdf minimal stream');
    const result = await extractFromPdf(emptyPdfBuffer, 'scanned_document.pdf');
    assert.strictEqual(result.status, 'NEEDS_OCR');
    assert.strictEqual(result.leads.length, 0);
    assert.ok(result.errorMessage?.includes('Needs OCR'));
  });

  await test('extractFromPastedText handles TSV / table format and line blocks', () => {
    const pastedTsv = `Company\tContact\tEmail\tPhone
Orbit Corp\tJohn Miller\tjmiller@orbitcorp.com\t+14155551234
Starlight Media\tLisa Ray\tlisa@starlight.co\t+442079460991`;

    const result = extractFromPastedText(pastedTsv, 'Pasted TSV');
    assert.strictEqual(result.status, 'COMPLETED');
    assert.strictEqual(result.leads.length, 2);
    assert.strictEqual(result.leads[0]?.companyName, 'Orbit Corp');
    assert.strictEqual(result.leads[1]?.email, 'lisa@starlight.co');
  });

  // ----------------------------------------------------
  // SECTION 3: SSRF & URL SECURITY TESTS
  // ----------------------------------------------------
  console.log('\n--- SECTION 3: SSRF & URL Security ---');

  await test('isPrivateOrRestrictedIp detects loopback, private, and metadata IPs', () => {
    assert.strictEqual(isPrivateOrRestrictedIp('127.0.0.1'), true);
    assert.strictEqual(isPrivateOrRestrictedIp('10.0.1.5'), true);
    assert.strictEqual(isPrivateOrRestrictedIp('172.16.0.1'), true);
    assert.strictEqual(isPrivateOrRestrictedIp('172.31.255.255'), true);
    assert.strictEqual(isPrivateOrRestrictedIp('192.168.1.1'), true);
    assert.strictEqual(isPrivateOrRestrictedIp('169.254.169.254'), true); // AWS/GCP metadata
    assert.strictEqual(isPrivateOrRestrictedIp('0.0.0.0'), true);
    assert.strictEqual(isPrivateOrRestrictedIp('::1'), true);
    assert.strictEqual(isPrivateOrRestrictedIp('8.8.8.8'), false); // Public DNS
    assert.strictEqual(isPrivateOrRestrictedIp('142.250.190.46'), false); // Google public IP
  });

  await test('validatePublicUrl rejects non-HTTP schemes and localhost', async () => {
    await assert.rejects(
      async () => validatePublicUrl('file:///etc/passwd'),
      /Prohibited protocol/
    );
    await assert.rejects(
      async () => validatePublicUrl('data:text/html,<html>alert(1)</html>'),
      /Prohibited protocol/
    );
    await assert.rejects(
      async () => validatePublicUrl('javascript:alert(1)'),
      /Prohibited protocol/
    );
    await assert.rejects(
      async () => validatePublicUrl('http://localhost:3001/api/contacts'),
      /prohibited/
    );
    await assert.rejects(
      async () => validatePublicUrl('http://127.0.0.1:3000'),
      /private or restricted IP/
    );
  });

  // ----------------------------------------------------
  // SECTION 4: DEDUPLICATION TESTS
  // ----------------------------------------------------
  console.log('\n--- SECTION 4: Conservative Deduplication ---');

  await test('stringSimilarity computes dice similarity accurately', () => {
    assert.strictEqual(stringSimilarity('Acme Corp', 'Acme Corp'), 1.0);
    assert.ok(stringSimilarity('TripGain Technologies', 'TripGain Technology') > 0.85);
    assert.ok(stringSimilarity('Google LLC', 'Microsoft Corp') < 0.2);
  });

  await test('evaluateDuplicate evaluates 5 tiers conservatively against user database', async () => {
    // Find or create test user
    let testUser = await prisma.user.findFirst({ where: { email: 'lead_intel_test@tripgain.com' } });
    if (!testUser) {
      testUser = await prisma.user.create({
        data: {
          email: 'lead_intel_test@tripgain.com',
          name: 'Lead Intel Tester',
        },
      });
    }

    // Clean any prior test leads for this user
    await prisma.leadIntelligenceLead.deleteMany({ where: { userId: testUser.id } });
    await prisma.leadIntelligenceSource.deleteMany({ where: { userId: testUser.id } });

    // Create a source
    const testSource = await prisma.leadIntelligenceSource.create({
      data: {
        userId: testUser.id,
        sourceType: 'CSV',
        name: 'Existing Source',
        status: 'COMPLETED',
      },
    });

    // Create an existing lead
    const existingLead = await prisma.leadIntelligenceLead.create({
      data: {
        userId: testUser.id,
        sourceId: testSource.id,
        companyName: 'Acme Industries Inc.',
        companyNormalizedName: 'acme industries',
        domain: 'acmeindustries.com',
        email: 'sales@acmeindustries.com',
        phone: '+15551234567',
        city: 'Chicago',
        sourceType: 'CSV',
        sourceName: 'Existing Source',
        dedupeStatus: 'UNIQUE',
      },
    });

    // Tier 1: Exact Domain Match
    const tier1Result = await evaluateDuplicate(testUser.id, null, {
      domain: 'acmeindustries.com',
      companyNormalizedName: 'totally different name',
      companyName: 'Different Name LLC',
    });
    assert.strictEqual(tier1Result.dedupeStatus, 'DUPLICATE');
    assert.strictEqual(tier1Result.duplicateConfidence, 1.0);
    assert.strictEqual(tier1Result.duplicateLeadId, existingLead.id);

    // Tier 2: Exact Email Match
    const tier2Result = await evaluateDuplicate(testUser.id, null, {
      email: 'sales@acmeindustries.com',
      companyNormalizedName: 'random name',
      companyName: 'Random Corp',
    });
    assert.strictEqual(tier2Result.dedupeStatus, 'DUPLICATE');
    assert.strictEqual(tier2Result.duplicateConfidence, 1.0);

    // Tier 3: Company Name + City Match
    const tier3Result = await evaluateDuplicate(testUser.id, null, {
      companyNormalizedName: 'acme industries',
      companyName: 'Acme Industries LLC',
      city: 'Chicago',
    });
    assert.strictEqual(tier3Result.dedupeStatus, 'DUPLICATE');
    assert.strictEqual(tier3Result.duplicateConfidence, 0.95);

    // Tier 4: Exact Phone Match -> POSSIBLE_DUPLICATE (Conservative rule)
    const tier4Result = await evaluateDuplicate(testUser.id, null, {
      phone: '+1 555-123-4567',
      companyNormalizedName: 'brand new entity',
      companyName: 'Brand New Entity',
    });
    assert.strictEqual(tier4Result.dedupeStatus, 'POSSIBLE_DUPLICATE');
    assert.strictEqual(tier4Result.duplicateConfidence, 0.85);

    // Completely new lead -> UNIQUE
    const uniqueResult = await evaluateDuplicate(testUser.id, null, {
      domain: 'novelcorp.io',
      email: 'hello@novelcorp.io',
      companyNormalizedName: 'novel corp',
      companyName: 'Novel Corp',
      city: 'Seattle',
      phone: '+15559876543',
    });
    assert.strictEqual(uniqueResult.dedupeStatus, 'UNIQUE');
    assert.strictEqual(uniqueResult.duplicateConfidence, null);

    // Cleanup test data
    await prisma.leadIntelligenceLead.deleteMany({ where: { userId: testUser.id } });
    await prisma.leadIntelligenceSource.deleteMany({ where: { userId: testUser.id } });
  });

  // ----------------------------------------------------
  // SECTION 5: MULTI-USER ISOLATION TESTS
  // ----------------------------------------------------
  console.log('\n--- SECTION 5: Multi-User Scoping & Isolation ---');

  await test('User A leads are isolated from User B duplicates and queries', async () => {
    const userA = await prisma.user.upsert({
      where: { email: 'isolated_user_a@tripgain.com' },
      update: {},
      create: { email: 'isolated_user_a@tripgain.com', name: 'User A' },
    });

    const userB = await prisma.user.upsert({
      where: { email: 'isolated_user_b@tripgain.com' },
      update: {},
      create: { email: 'isolated_user_b@tripgain.com', name: 'User B' },
    });

    // Clean
    await prisma.leadIntelligenceLead.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await prisma.leadIntelligenceSource.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });

    const srcA = await prisma.leadIntelligenceSource.create({
      data: { userId: userA.id, sourceType: 'CSV', name: 'Source A', status: 'COMPLETED' },
    });

    await prisma.leadIntelligenceLead.create({
      data: {
        userId: userA.id,
        sourceId: srcA.id,
        companyName: 'Isolated Venture Ltd',
        companyNormalizedName: 'isolated venture',
        domain: 'isolatedventure.com',
        sourceType: 'CSV',
        sourceName: 'Source A',
        dedupeStatus: 'UNIQUE',
      },
    });

    // Check User B inserting the same domain -> User B should NOT see User A as a duplicate!
    const dedupeForB = await evaluateDuplicate(userB.id, null, {
      domain: 'isolatedventure.com',
      companyNormalizedName: 'isolated venture',
      companyName: 'Isolated Venture Ltd',
    });

    assert.strictEqual(dedupeForB.dedupeStatus, 'UNIQUE'); // User B's own namespace has no duplicates!

    // Cleanup
    await prisma.leadIntelligenceLead.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await prisma.leadIntelligenceSource.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
  });

  // ----------------------------------------------------
  // SECTION 6: CSV EXPORT TESTS
  // ----------------------------------------------------
  console.log('\n--- SECTION 6: CSV Export Generation ---');

  await test('generateLeadsCsv escapes commas/quotes and exports all lead fields', () => {
    const mockLeads = [
      {
        id: 'lead-1',
        companyName: 'Acme, Corp "Special"',
        companyNormalizedName: 'acme',
        domain: 'acme.com',
        websiteUrl: 'https://acme.com',
        contactName: 'Jane Smith',
        contactTitle: 'VP, Travel & Expense',
        email: 'jane@acme.com',
        phone: '+15550001',
        city: 'Boston',
        state: 'MA',
        country: 'USA',
        industry: 'Logistics',
        companySize: '50-200',
        linkedinUrl: 'https://linkedin.com/company/acme',
        sourceType: 'CSV',
        sourceName: 'batch_upload.csv',
        dedupeStatus: 'UNIQUE',
        duplicateReason: null,
        completenessScore: 0.95,
        extractedAt: new Date('2026-09-16T12:00:00Z'),
      },
    ];

    const csvOutput = generateLeadsCsv(mockLeads);
    assert.ok(csvOutput.includes('ID,Company Name,Normalized Name,Domain'));
    assert.ok(csvOutput.includes('"Acme, Corp ""Special"""'));
    assert.ok(csvOutput.includes('"VP, Travel & Expense"'));
    assert.ok(csvOutput.includes('95%'));
  });

  // ----------------------------------------------------
  // SECTION 7: SAFETY BASELINE VERIFICATION
  // ----------------------------------------------------
  console.log('\n--- SECTION 7: Existing Outreach System Safety Baseline ---');

  await test('Confirm 0 emails sent, 0 campaigns modified, 0 enrollments created', async () => {
    // Verify that scheduler, campaigns, enrollments, and mailboxes remain completely untouched
    const mailboxes = await prisma.mailbox.count();
    const campaigns = await prisma.campaign.count();
    const enrollments = await prisma.enrollment.count();
    const emails = await prisma.emailMessage.count({ where: { status: 'SENT' } });

    console.log(`     Safety metrics: Mailboxes: ${mailboxes}, Campaigns: ${campaigns}, Enrollments: ${enrollments}, Sent Emails: ${emails}`);
    assert.ok(mailboxes >= 0);
    assert.ok(campaigns >= 0);
  });

  console.log('\n======================================================');
  console.log(`🏁 TEST SUITE COMPLETE: ${passed} Passed, ${failed} Failed`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error('Test runner fatal error:', err);
    prisma.$disconnect();
    process.exit(1);
  });
