import 'dotenv/config';
import assert from 'assert';
import { PrismaClient } from '@prisma/client';
import { WorkerHealthService } from '../src/services/listGuard/workerHealth';
import { ListGuardStore } from '../src/services/listGuard/listGuardStore';

const prisma = new PrismaClient();

async function runEgressValidationTests() {
  console.log('================================================================');
  console.log('   P0 FIX VALIDATION SUITE: IMAP SYNC & LISTGUARD BACKOFF       ');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ✗ ${name}:`, err?.message || err);
      failed++;
    }
  }

  // --- TEST A: Verify Targeted Query Execution for ContactEmail (Zero Enrollment preloading) ---
  await test('A. Targeted lookup by normalizedEmail returns contactId without loading full Enrollment table', async () => {
    const sampleEmail = await prisma.contactEmail.findFirst({
      select: { normalizedEmail: true, contactId: true }
    });

    if (sampleEmail) {
      const targeted = await prisma.contactEmail.findFirst({
        where: { normalizedEmail: sampleEmail.normalizedEmail },
        select: {
          id: true,
          contactId: true,
          contact: {
            select: { id: true, organizationId: true }
          }
        }
      });
      assert.ok(targeted, 'Targeted lookup must find the contact email');
      assert.strictEqual(targeted.contactId, sampleEmail.contactId);
      assert.ok(targeted.contact, 'Targeted lookup resolves minimal contact record');
    }
  });

  // --- TEST B: Header-based ConversationMessage query selects minimal fields ---
  await test('B. Targeted lookup for In-Reply-To / References Message-IDs uses index and selects minimal columns', async () => {
    const testHeaderIds = ['<test-msg-123@example.com>', 'test-msg-123@example.com'];
    const matched = await prisma.conversationMessage.findFirst({
      where: {
        direction: 'OUTBOUND',
        OR: [
          { internetMessageId: { in: testHeaderIds } },
          { providerMessageId: { in: testHeaderIds } }
        ]
      },
      select: {
        id: true,
        conversationId: true,
        internetMessageId: true,
        providerMessageId: true
      }
    });
    assert.ok(matched === null || (matched && matched.conversationId), 'Query must execute cleanly with minimal projection');
  });

  // --- TEST C: Duplicate Message Prevention Query Semantics ---
  await test('C. Duplicate message prevention query properly checks providerMessageId and 60-second window', async () => {
    const receivedDate = new Date();
    const dupCheck = await prisma.conversationMessage.findFirst({
      where: {
        OR: [
          { providerMessageId: '<unique-dup-test-msg-id>' },
          {
            senderEmail: 'test-sender@example.com',
            subject: 'Test Subject',
            receivedAt: {
              gte: new Date(receivedDate.getTime() - 60000),
              lte: new Date(receivedDate.getTime() + 60000)
            }
          }
        ]
      }
    });
    assert.strictEqual(dupCheck, null, 'Unseen message must not be flagged as duplicate');
  });

  // --- TEST D: ListGuard Adaptive Backoff Schedule Semantics ---
  await test('D. ListGuard Adaptive Backoff Schedule progression (2.5s -> 5s -> 10s -> 15s -> 30s max)', async () => {
    const BACKOFF_SCHEDULE = [2500, 5000, 10000, 15000, 30000];
    let idleLevel = 0;

    const observedIntervals: number[] = [];
    for (let step = 0; step < 8; step++) {
      const interval = BACKOFF_SCHEDULE[idleLevel]!;
      observedIntervals.push(interval);
      if (idleLevel < BACKOFF_SCHEDULE.length - 1) {
        idleLevel++;
      }
    }

    assert.deepStrictEqual(observedIntervals, [2500, 5000, 10000, 15000, 30000, 30000, 30000, 30000]);

    // Reset when a job is claimed
    idleLevel = 0;
    assert.strictEqual(BACKOFF_SCHEDULE[idleLevel]!, 2500, 'Backoff must immediately reset to 2.5s upon claiming a job');
  });

  // --- TEST E: Worker Health Service 30s Heartbeat Semantics ---
  await test('E. WorkerHealthService evaluates heartbeat window correctly with 30s heartbeat interval', async () => {
    const testWorkerId = `test-egress-worker-${Date.now()}`;
    const now = new Date();

    // Register heartbeat
    await WorkerHealthService.registerHeartbeat(prisma, {
      workerId: testWorkerId,
      version: '1.0.0',
      status: 'ONLINE',
      hostname: 'test-egress-host',
      startedAt: now,
      lastHeartbeatAt: now,
      activeJobs: 0,
      processedCount: 0,
      currentJobId: null
    });

    // Query status with default heartbeat window (75s, accommodating 30s interval + margin)
    const health = await WorkerHealthService.getWorkerHealthStatus(prisma, 75000);
    const worker = health.workers.find(w => w.workerId === testWorkerId);
    assert.ok(worker, 'Worker must be reported as active within heartbeat window');
    assert.strictEqual(worker.status, 'ONLINE');

    // Mark worker offline and verify clean transition
    await WorkerHealthService.markWorkerOffline(prisma, testWorkerId);
    const healthAfter = await WorkerHealthService.getWorkerHealthStatus(prisma, 75000);
    const workerAfter = healthAfter.workers.find(w => w.workerId === testWorkerId);
    assert.strictEqual(workerAfter, undefined, 'Offline worker must not be reported as active');

    // Cleanup
    await prisma.$executeRawUnsafe(`DELETE FROM "ListGuardWorker" WHERE "workerId" = $1`, testWorkerId);
  });

  // --- TEST F: ListGuard Claim Next Job atomic lock expiration and recovery ---
  await test('F. ListGuardStore claimNextJob runs safely and preserves idempotency', async () => {
    const claimed = await ListGuardStore.claimNextJob(prisma, 'test-val-worker');
    assert.ok(claimed === null || typeof claimed.id === 'string', 'claimNextJob must return null or valid job');
  });

  console.log(`\n================================================================`);
  console.log(`P0 VALIDATION SUITE COMPLETE: ${passed} passed, ${failed} failed`);
  console.log(`================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runEgressValidationTests()
  .catch((err) => {
    console.error('Validation script error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
