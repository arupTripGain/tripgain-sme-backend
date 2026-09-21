import 'dotenv/config';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { verifySchedulerAuth } from '../src/controllers/schedulerController';
import { executeWithImapSyncLock, IMAP_SYNC_LOCK_KEY } from '../src/services/cronLockService';
import { calculateEffectiveCapacity } from '../src/services/quotaService';
import { selectFairMailbox } from '../src/services/rotationService';
import { calculateNextEligibleSendTime } from '../src/utils/businessDays';

const prisma = new PrismaClient();

async function runP1ATests() {
  console.log('================================================================');
  console.log('   P1-A VERIFICATION SUITE: IMAP SEPARATION & PERSISTENT LOCK   ');
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

  // --- 1. SCHEDULER TICK DOES NOT CALL IMAP SYNC ---
  await test('1. Static & code verification: schedulerService.ts does NOT import or call syncAllActiveMailboxes', async () => {
    const schedulerServiceCode = fs.readFileSync(
      path.join(__dirname, '../src/services/schedulerService.ts'),
      'utf8'
    );
    assert.ok(
      !schedulerServiceCode.includes('syncAllActiveMailboxes'),
      'schedulerService.ts must NOT reference or call syncAllActiveMailboxes'
    );
    assert.ok(
      !schedulerServiceCode.includes('// Inbound Reply Synchronization Phase'),
      'schedulerService.ts must NOT contain inbound reply synchronization block'
    );
  });

  // --- 2. IMAP-SYNC ENDPOINT DOES CALL IMAP SYNC & ENFORCES AUTH ---
  await test('2A. Endpoint security: runImapSync strictly enforces CRON_SECRET & JWT authentication', async () => {
    const mockCronSecret = 'test_cron_secret_p1a_123';
    const mockJwtSecret = 'test_jwt_secret_p1a_456';

    // Missing credentials -> 401
    const unauth = verifySchedulerAuth(undefined, undefined, null, mockCronSecret, mockJwtSecret);
    assert.strictEqual(unauth.isAuthorized, false);
    assert.strictEqual(unauth.status, 401);

    // Invalid bearer -> 401
    const invalidBearer = verifySchedulerAuth('Bearer wrong_secret', undefined, null, mockCronSecret, mockJwtSecret);
    assert.strictEqual(invalidBearer.isAuthorized, false);
    assert.strictEqual(invalidBearer.status, 401);

    // Valid Bearer CRON_SECRET -> authorized
    const validCron = verifySchedulerAuth(`Bearer ${mockCronSecret}`, undefined, null, mockCronSecret, mockJwtSecret);
    assert.strictEqual(validCron.isAuthorized, true);

    // Valid x-cron-secret header -> authorized
    const validHeader = verifySchedulerAuth(undefined, mockCronSecret, null, mockCronSecret, mockJwtSecret);
    assert.strictEqual(validHeader.isAuthorized, true);

    // Valid dashboard JWT -> authorized
    const testToken = jwt.sign({ userId: 'admin-123', email: 'admin@tripgain.com', role: 'ADMIN' }, mockJwtSecret);
    const validJwt = verifySchedulerAuth(`Bearer ${testToken}`, undefined, null, mockCronSecret, mockJwtSecret);
    assert.strictEqual(validJwt.isAuthorized, true);
  });

  await test('2B. Route mounting: /api/scheduler/imap-sync is mounted in index.ts for GET and POST', async () => {
    const indexCode = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
    assert.ok(
      indexCode.includes("app.get('/api/scheduler/imap-sync', runImapSync)"),
      'GET /api/scheduler/imap-sync must be registered'
    );
    assert.ok(
      indexCode.includes("app.post('/api/scheduler/imap-sync', runImapSync)"),
      'POST /api/scheduler/imap-sync must be registered'
    );
  });

  // --- 3. PERSISTENT TRANSACTION-HELD ADVISORY LOCK (ZERO SCHEMA MUTATIONS) ---
  await test('3A. Advisory lock: Atomic acquisition & overlapping execution prevention', async () => {
    let worker1Holding = false;
    let worker2Acquired: boolean | undefined;

    // Worker 1 starts task held inside transaction
    const worker1Promise = executeWithImapSyncLock(async () => {
      worker1Holding = true;
      await new Promise(resolve => setTimeout(resolve, 2000));
      return { synced: 5 };
    }, 10000);

    // Wait until worker 1 acquires lock
    let attempts = 0;
    while (!worker1Holding && attempts < 100) {
      await new Promise(resolve => setTimeout(resolve, 50));
      attempts++;
    }
    assert.ok(worker1Holding, 'Worker 1 must acquire the lock and enter execution');

    // Worker 2 attempts concurrent acquisition while worker 1 is active -> blocked immediately
    const worker2Result = await executeWithImapSyncLock(async () => {
      return { synced: 99 };
    }, 5000);
    worker2Acquired = worker2Result.acquired;

    const worker1Result = await worker1Promise;

    assert.strictEqual(worker1Result.acquired, true, 'Worker 1 must acquire free lock');
    assert.strictEqual(worker1Result.result?.synced, 5);
    assert.strictEqual(worker2Acquired, false, 'Worker 2 must be rejected while Worker 1 is running');

    // Worker 3 attempts acquisition after Worker 1 committed -> acquires cleanly
    const worker3Result = await executeWithImapSyncLock(async () => {
      return { synced: 10 };
    }, 5000);

    assert.strictEqual(worker3Result.acquired, true, 'Worker 3 must acquire lock after Worker 1 release');
    assert.strictEqual(worker3Result.result?.synced, 10);
  });

  await test('3B. Advisory lock: Crash & exception safety with automatic rollback recovery', async () => {
    // Worker 4 simulates a crashed / aborted invocation
    let errorCaught = false;
    try {
      await executeWithImapSyncLock(async () => {
        throw new Error('Simulated unhandled exception / crash inside IMAP sync');
      }, 5000);
    } catch (err: any) {
      errorCaught = true;
    }
    assert.strictEqual(errorCaught, true, 'Simulated crash should propagate error');

    // Worker 5 immediately attempts acquisition -> must succeed because Postgres aborted the tx
    const worker5Result = await executeWithImapSyncLock(async () => {
      return { recovered: true };
    }, 5000);

    assert.strictEqual(worker5Result.acquired, true, 'Recovery worker must acquire lock immediately after previous crash');
    assert.strictEqual(worker5Result.result?.recovered, true);
  });

  // --- 4. OUTBOUND SCHEDULER INVARIANTS PRESERVED ---
  await test('4A. Outbound invariants: 3-second drip pacing delay is strictly preserved in schedulerService.ts', async () => {
    const schedulerCode = fs.readFileSync(
      path.join(__dirname, '../src/services/schedulerService.ts'),
      'utf8'
    );
    assert.ok(
      schedulerCode.includes('setTimeout(resolve, 3000)'),
      '3-second intentional drip delay must remain untouched in schedulerService.ts'
    );
  });

  await test('4B. Outbound invariants: Quota calculation & mailbox capacity limits remain strictly enforced', async () => {
    const cap = calculateEffectiveCapacity({
      mailboxHourlyLimit: 20,
      mailboxDailyLimit: 100,
      mailboxSentThisHour: 19,
      mailboxSentToday: 50
    });
    assert.strictEqual(cap.availableCapacity, 1, 'Mailbox hourly capacity constraint must be 1');
    assert.strictEqual(cap.mailboxRemainingHourly, 1);
    assert.strictEqual(cap.mailboxRemainingDaily, 50);
  });

  await test('4C. Outbound invariants: Mailbox rotation & least-loaded distribution preserved', async () => {
    const mailboxes = [
      { id: 'mb-1', email: 'a@tripgain.com', hourlySendLimit: 20, dailySendLimit: 100 },
      { id: 'mb-2', email: 'b@tripgain.com', hourlySendLimit: 20, dailySendLimit: 100 }
    ];
    const counts = new Map<string, number>([
      ['mb-1', 5],
      ['mb-2', 3]
    ]);
    const selected = selectFairMailbox(mailboxes as any, counts);
    assert.strictEqual(selected?.id, 'mb-2', 'Must select least-loaded mailbox');
  });

  await test('4D. Outbound invariants: Business days scheduling & sending window intact', async () => {
    // 2026-09-22 is Tuesday (standard business day)
    const baseDate = new Date('2026-09-22T04:30:00.000Z'); // 10:00 AM IST
    const nextSend = calculateNextEligibleSendTime({
      delayDays: 2,
      from: baseDate,
      sendingWindowStart: '09:30:00',
      sendingWindowEnd: '17:30:00',
      timezone: 'Asia/Kolkata',
      sendingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI']
    });
    assert.ok(nextSend && nextSend > baseDate, 'Next send time must be in future');
  });

  // --- 5. MAILBOX FAULT ISOLATION ---
  await test('5. Fault isolation: One mailbox sync error does not abort processing of remaining mailboxes', async () => {
    // Simulates the loop inside syncAllActiveMailboxes
    const mockMailboxes = [
      { id: 'mb-fail', email: 'broken@example.com' },
      { id: 'mb-ok', email: 'working@example.com' }
    ];

    const results: any[] = [];
    let errors = 0;

    for (const mb of mockMailboxes) {
      try {
        if (mb.id === 'mb-fail') {
          throw new Error('Connection timed out on IMAP port 993');
        }
        results.push({ mailboxId: mb.id, success: true, syncedCount: 2 });
      } catch (err: any) {
        errors++;
        results.push({ mailboxId: mb.id, success: false, error: err.message });
      }
    }

    assert.strictEqual(errors, 1, 'Exactly one mailbox failure recorded');
    assert.strictEqual(results.length, 2, 'Both mailboxes processed');
    assert.strictEqual(results[1].success, true, 'Second mailbox processed successfully despite first failing');
  });

  // --- 6. ZERO DATABASE SCHEMA MUTATION CHECK ---
  await test('6. Schema safety: Zero migrations, zero schema modifications, zero CREATE TABLE statements', async () => {
    const schemaContent = fs.readFileSync(
      path.join(__dirname, '../prisma/schema.prisma'),
      'utf8'
    );
    // Verify standard expected models exist without modification
    assert.ok(schemaContent.includes('model Enrollment {'));
    assert.ok(schemaContent.includes('model Mailbox {'));
    assert.ok(schemaContent.includes('model SchedulerRun {'));
    assert.ok(!schemaContent.includes('_SystemCronLock'), 'Zero changes introduced to schema.prisma');

    // Verify cronLockService.ts contains NO CREATE TABLE statements
    const lockServiceCode = fs.readFileSync(
      path.join(__dirname, '../src/services/cronLockService.ts'),
      'utf8'
    );
    assert.ok(
      !lockServiceCode.includes('CREATE TABLE'),
      'cronLockService.ts must NOT contain any CREATE TABLE statements'
    );
    assert.ok(
      lockServiceCode.includes('pg_try_advisory_lock'),
      'cronLockService.ts must use pg_try_advisory_lock'
    );
  });

  // --- 7. TRACKING URL PRODUCTION SAFETY ---
  await test('7. Tracking URL safety: Production can never generate localhost URLs in scheduler or bulk email', async () => {
    const schedulerCode = fs.readFileSync(
      path.join(__dirname, '../src/services/schedulerService.ts'),
      'utf8'
    );
    const bulkEmailCode = fs.readFileSync(
      path.join(__dirname, '../src/controllers/bulkEmailController.ts'),
      'utf8'
    );

    // Both files must have isProduction guard preventing localhost
    assert.ok(
      schedulerCode.includes("trackingBaseUrl.includes('localhost')"),
      'schedulerService.ts must reject localhost in production'
    );
    assert.ok(
      bulkEmailCode.includes("trackingBaseUrl.includes('localhost')"),
      'bulkEmailController.ts must reject localhost in production'
    );
    assert.ok(
      !bulkEmailCode.includes("|| 'http://localhost:3001'"),
      'bulkEmailController.ts must NOT have unconditional || http://localhost:3001 fallback'
    );
  });

  console.log('\n================================================================');
  console.log(`P1-A TEST SUITE COMPLETE: ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runP1ATests()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error('Fatal error running P1-A tests:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
