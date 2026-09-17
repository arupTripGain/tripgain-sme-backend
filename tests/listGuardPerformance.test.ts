import 'dotenv/config';
import assert from 'assert';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { ListGuardQueue } from '../src/services/listGuard/listGuardQueue';
import { ListGuardStore } from '../src/services/listGuard/listGuardStore';
import { setTestSmtpMockHandler } from '../src/services/listGuard/smtpVerifier';

const prisma = new PrismaClient();

async function runListGuardPerformanceTests() {
  console.log('--- STARTING LISTGUARD HIGH-VOLUME PERFORMANCE TEST ---');

  const RECORD_COUNT = 1000;
  console.log(`\nPreparing test dataset of ${RECORD_COUNT} records...`);

  // Setup mock SMTP handler so no real network sockets are opened
  let currentConcurrentChecks = 0;
  let maxConcurrentObserved = 0;

  setTestSmtpMockHandler(async (email, domain) => {
    currentConcurrentChecks++;
    if (currentConcurrentChecks > maxConcurrentObserved) {
      maxConcurrentObserved = currentConcurrentChecks;
    }

    // Small simulated processing latency
    await new Promise((r) => setTimeout(r, 1));

    currentConcurrentChecks--;

    const hash = email.length % 4;
    if (hash === 0) {
      return {
        smtpStatus: 'DELIVERABLE_SIGNAL',
        isCatchAll: false,
        smtpResponseCode: '250',
        smtpResponse: '250 OK',
        attempts: 1
      };
    } else if (hash === 1) {
      return {
        smtpStatus: 'CATCH_ALL',
        isCatchAll: true,
        smtpResponseCode: '250',
        smtpResponse: '250 OK catch-all',
        attempts: 1
      };
    } else if (hash === 2) {
      return {
        smtpStatus: 'UNDELIVERABLE_SIGNAL',
        isCatchAll: false,
        smtpResponseCode: '550',
        smtpResponse: '550 User unknown',
        attempts: 1
      };
    } else {
      return {
        smtpStatus: 'UNKNOWN',
        isCatchAll: false,
        smtpResponseCode: '450',
        smtpResponse: '450 Temporary greylist',
        attempts: 2
      };
    }
  });

  const testUser = await prisma.user.upsert({
    where: { email: 'perf_test_user@tripgain.com' },
    update: {},
    create: { email: 'perf_test_user@tripgain.com', name: 'Perf User', role: 'MEMBER' }
  });

  const workspace = await prisma.workspace.findFirst({ where: { userId: testUser.id } }) ||
    await prisma.workspace.create({ data: { name: 'Perf WS', userId: testUser.id } });

  const perfList = await prisma.list.create({
    data: {
      name: `Performance List ${RECORD_COUNT} Contacts`,
      userId: testUser.id,
      workspaceId: workspace.id,
      listType: 'static'
    }
  });

  // Create contacts in batches for speed
  console.log('Generating contacts and list memberships in database...');
  const batchSize = 250;
  const contactIds: string[] = [];

  for (let b = 0; b < RECORD_COUNT; b += batchSize) {
    const currentBatchCount = Math.min(batchSize, RECORD_COUNT - b);
    const newIds = Array.from({ length: currentBatchCount }).map(() => crypto.randomUUID());
    contactIds.push(...newIds);

    const contactsBatch = newIds.map((cid, i) => {
      const idx = b + i;
      return {
        id: cid,
        userId: testUser.id,
        workspaceId: workspace.id,
        firstName: `Lead${idx}`,
        lastName: `Test${idx}`,
        jobTitle: `Role ${idx}`,
        city: 'Bengaluru'
      };
    });

    await prisma.contact.createMany({ data: contactsBatch });

    // Create emails & list members
    const emailData = newIds.map((cid, i) => {
      const idx = b + i;
      const domainId = idx % 20;
      const email = `lead_${idx}@company${domainId}.com`;
      return {
        contactId: cid,
        email,
        normalizedEmail: email,
        isPrimary: true
      };
    });

    await prisma.contactEmail.createMany({ data: emailData });

    const memberData = newIds.map(cid => ({
      listId: perfList.id,
      contactId: cid,
      membershipStatus: 'active'
    }));

    await prisma.listMember.createMany({ data: memberData });
  }

  console.log(`Created ${contactIds.length} contacts and list members.`);

  // Measure initial memory
  const initialMem = process.memoryUsage().heapUsed;
  const startTime = Date.now();

  // Start verification job
  console.log('Starting asynchronous verification job...');
  const startRes = await ListGuardQueue.startJob({
    listId: perfList.id,
    userId: testUser.id
  });

  const enqueueTime = Date.now() - startTime;
  console.log(`Job enqueued in ${enqueueTime}ms. Job ID: ${startRes.jobId}, Total: ${startRes.total}`);
  assert.ok(enqueueTime < 3000, `Enqueue took too long: ${enqueueTime}ms`);
  assert.strictEqual(startRes.total, RECORD_COUNT);

  // Monitor progress
  let completed = false;
  let lastProcessed = 0;
  let pollCount = 0;

  while (!completed) {
    await new Promise((r) => setTimeout(r, 400));
    pollCount++;

    const progress = await ListGuardQueue.getJobProgress(startRes.jobId, testUser.id);
    if (progress) {
      if (progress.processed !== lastProcessed) {
        lastProcessed = progress.processed;
        process.stdout.write(`\r  Progress: ${progress.processed}/${progress.total} (${Math.round((progress.processed / progress.total) * 100)}%) | Max Concurrency: ${maxConcurrentObserved}`);
      }

      if (progress.status === 'COMPLETED' || progress.status === 'FAILED' || progress.status === 'CANCELLED') {
        completed = true;
        console.log(`\nJob finished with status: ${progress.status}`);
        assert.strictEqual(progress.status, 'COMPLETED');
        assert.strictEqual(progress.processed, RECORD_COUNT);
        assert.strictEqual(
          progress.deliverable + progress.catchAll + progress.unknown + progress.undeliverable,
          RECORD_COUNT
        );
      }
    }

    // Safety timeout: 120 seconds
    if (Date.now() - startTime > 120000) {
      throw new Error('Performance test timed out after 120s');
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  const throughput = Math.round(RECORD_COUNT / parseFloat(durationSec));
  const finalMem = process.memoryUsage().heapUsed;
  const memDeltaMb = Math.round((finalMem - initialMem) / (1024 * 1024));

  console.log('\n--- PERFORMANCE SUMMARY ---');
  console.log(`Records Processed:   ${RECORD_COUNT}`);
  console.log(`Total Duration:      ${durationSec}s`);
  console.log(`Throughput:          ${throughput} records/sec`);
  console.log(`Max Concurrency:     ${maxConcurrentObserved}`);
  console.log(`Heap Delta:          ${memDeltaMb} MB`);

  // Assertions
  assert.ok(maxConcurrentObserved <= 10, `Concurrency exceeded limit: ${maxConcurrentObserved}`);
  assert.ok(memDeltaMb < 150, `Memory footprint grew excessively: ${memDeltaMb} MB`);

  // Verify full export retrieval on 1,000 records
  const allResults = await ListGuardStore.getAllResultsForJob(prisma, startRes.jobId);
  assert.strictEqual(allResults.length, RECORD_COUNT, 'All 1,000 results must be present in full export');

  // Verify deduplication: no duplicate email in results
  const uniqueEmails = new Set(allResults.map(r => r.normalizedEmail));
  assert.strictEqual(uniqueEmails.size, RECORD_COUNT, 'No duplicate results should be generated');

  // Cleanup test data
  setTestSmtpMockHandler(null);
  console.log('Cleaning up test data...');
  await prisma.listMember.deleteMany({ where: { listId: perfList.id } }).catch(() => {});
  await prisma.list.delete({ where: { id: perfList.id } }).catch(() => {});
  await prisma.contactEmail.deleteMany({ where: { contactId: { in: contactIds } } }).catch(() => {});
  await prisma.contact.deleteMany({ where: { id: { in: contactIds } } }).catch(() => {});
  await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});

  console.log('\n==================================================');
  console.log(`LISTGUARD PERFORMANCE TEST PASSED (1,000 records)`);
  console.log(`==================================================`);
}

runListGuardPerformanceTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Performance test failed:', err);
    process.exit(1);
  });
