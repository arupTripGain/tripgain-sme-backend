import 'dotenv/config';
import assert from 'assert';
import { PrismaClient } from '@prisma/client';
import { RateLimiter } from '../src/services/listGuard/rateLimiter';
import { DomainCircuitBreaker } from '../src/services/listGuard/circuitBreaker';
import { WorkerHealthService } from '../src/services/listGuard/workerHealth';
import { ListGuardStore } from '../src/services/listGuard/listGuardStore';

const prisma = new PrismaClient();

async function runTests() {
  console.log('--- STARTING LISTGUARD WORKER ARCHITECTURE TESTS ---');

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

  // 1. RATE LIMITER TESTS
  await test('RateLimiter enforces global concurrency maximum', async () => {
    const limiter = new RateLimiter({ maxGlobalConcurrency: 3, maxPerDomainConcurrency: 2 });
    assert.strictEqual(limiter.acquire('domain-a.com'), true);
    assert.strictEqual(limiter.acquire('domain-b.com'), true);
    assert.strictEqual(limiter.acquire('domain-c.com'), true);
    // 4th acquisition should fail because global limit is 3
    assert.strictEqual(limiter.acquire('domain-d.com'), false);

    limiter.release('domain-a.com');
    assert.strictEqual(limiter.acquire('domain-d.com'), true);
  });

  await test('RateLimiter enforces per-domain concurrency maximum', async () => {
    const limiter = new RateLimiter({ maxGlobalConcurrency: 10, maxPerDomainConcurrency: 2 });
    assert.strictEqual(limiter.acquire('gmail.com'), true);
    assert.strictEqual(limiter.acquire('gmail.com'), true);
    // 3rd acquisition for gmail.com should fail
    assert.strictEqual(limiter.acquire('gmail.com'), false);
    // Other domain should succeed
    assert.strictEqual(limiter.acquire('yahoo.com'), true);

    limiter.release('gmail.com');
    assert.strictEqual(limiter.acquire('gmail.com'), true);
  });

  // 2. CIRCUIT BREAKER TESTS
  await test('CircuitBreaker stays CLOSED on successful requests and regular 550 mailbox rejections', async () => {
    const cb = new DomainCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    const domain = 'normal-domain.com';

    // Normal successes
    cb.recordSuccess(domain);
    assert.strictEqual(cb.canAttempt(domain).allowed, true);
    assert.strictEqual(cb.getState(domain).state, 'CLOSED');

    // Normal 550 mailbox rejections (isNetworkOrGatewayFailure = false)
    cb.recordFailure(domain, false);
    cb.recordFailure(domain, false);
    cb.recordFailure(domain, false);
    assert.strictEqual(cb.canAttempt(domain).allowed, true);
    assert.strictEqual(cb.getState(domain).state, 'CLOSED');
  });

  await test('CircuitBreaker trips to OPEN after consecutive network/timeout failures and recovers via HALF_OPEN', async () => {
    const cb = new DomainCircuitBreaker({ failureThreshold: 3, cooldownMs: 100 });
    const domain = 'unreachable-host.com';

    // 1st failure
    cb.recordFailure(domain, true);
    assert.strictEqual(cb.canAttempt(domain).allowed, true);

    // 2nd failure
    cb.recordFailure(domain, true);
    assert.strictEqual(cb.canAttempt(domain).allowed, true);

    // 3rd failure -> trips OPEN
    cb.recordFailure(domain, true);
    const checkOpen = cb.canAttempt(domain);
    assert.strictEqual(checkOpen.allowed, false);
    assert.strictEqual(checkOpen.state, 'OPEN');

    // Wait for cooldown
    await new Promise(r => setTimeout(r, 120));

    // Next attempt should be HALF_OPEN
    const checkHalfOpen = cb.canAttempt(domain);
    assert.strictEqual(checkHalfOpen.allowed, true);
    assert.strictEqual(checkHalfOpen.state, 'HALF_OPEN');

    // Successful test probe closes circuit
    cb.recordSuccess(domain);
    assert.strictEqual(cb.canAttempt(domain).state, 'CLOSED');
  });

  // 3. WORKER HEALTH TESTS
  await test('WorkerHealthService registers heartbeats and detects ONLINE vs UNAVAILABLE workers', async () => {
    const testWorkerId = `test-worker-${Date.now()}`;

    // Register active heartbeat
    await WorkerHealthService.registerHeartbeat(prisma, {
      workerId: testWorkerId,
      version: '1.0.0',
      status: 'ONLINE',
      startedAt: new Date(),
      lastHeartbeatAt: new Date(),
      activeJobs: 0,
      processedCount: 42,
      currentJobId: null
    });

    const health = await WorkerHealthService.getWorkerHealthStatus(prisma, 10000);
    assert.strictEqual(health.available, true);
    assert.ok(health.activeWorkerCount >= 1);
    assert.ok(health.workers.some(w => w.workerId === testWorkerId));

    // Mark offline
    await WorkerHealthService.markWorkerOffline(prisma, testWorkerId);
    const afterOffline = await WorkerHealthService.getWorkerHealthStatus(prisma, 10000);
    const workerFound = afterOffline.workers.find(w => w.workerId === testWorkerId);
    assert.strictEqual(workerFound, undefined);
  });

  // 4. ATOMIC JOB LEASING & RESUMPTION TESTS
  await test('ListGuardStore supports atomic job claiming and lock expiration', async () => {
    (ListGuardStore as any).dbHasTables = false;
    ListGuardStore.clearInMemoryForTesting();
    const testUserId = `user-${Date.now()}`;
    const testListId = `list-${Date.now()}`;

    // Create QUEUED job
    const created = await ListGuardStore.createJob(prisma, {
      listId: testListId,
      createdByUserId: testUserId,
      status: 'QUEUED',
      total: 10
    });

    assert.strictEqual(created.status, 'QUEUED');

    // Worker 1 claims job
    const claimed = await ListGuardStore.claimNextJob(prisma, 'worker-alpha', 500);
    assert.ok(claimed !== null);
    assert.strictEqual(claimed?.id, created.id);
    assert.strictEqual(claimed?.status, 'RUNNING');
    assert.strictEqual(claimed?.lockedBy, 'worker-alpha');

    // Second claim should return null because job is already locked
    const secondClaim = await ListGuardStore.claimNextJob(prisma, 'worker-beta', 500);
    assert.strictEqual(secondClaim, null);

    // Release lock
    await ListGuardStore.releaseJobLock(prisma, created.id);
  });

  await test('ListGuardStore getCompletedEmailSetForJob guarantees idempotency across worker restarts', async () => {
    const testJobId = `job-resume-${Date.now()}`;
    const emailA = 'alice@example.com';
    const emailB = 'bob@example.com';

    await ListGuardStore.createResult(prisma, {
      jobId: testJobId,
      email: emailA,
      normalizedEmail: emailA,
      result: 'DELIVERABLE',
      verificationReason: 'VALID_MAILBOX',
      confidence: 'HIGH',
      syntaxStatus: 'PASS',
      domainStatus: 'PASS',
      mxStatus: 'PASS',
      smtpStatus: 'DELIVERABLE_SIGNAL',
      isCatchAll: false,
      isDisposable: false,
      isRole: false,
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 100000)
    });

    const completed = await ListGuardStore.getCompletedEmailSetForJob(prisma, testJobId);
    assert.strictEqual(completed.has(emailA), true);
    assert.strictEqual(completed.has(emailB), false);
  });

  // 5. UNKNOWN REASONS DISTRIBUTION
  await test('ListGuardStore accurately breaks down UNKNOWN verification reasons', async () => {
    const testJobId = `job-unknowns-${Date.now()}`;

    // 2 SMTP_TIMEOUT results
    for (let i = 0; i < 2; i++) {
      await ListGuardStore.createResult(prisma, {
        jobId: testJobId,
        email: `timeout${i}@test.com`,
        normalizedEmail: `timeout${i}@test.com`,
        result: 'UNKNOWN',
        verificationReason: 'SMTP_TIMEOUT',
        confidence: 'LOW',
        syntaxStatus: 'PASS',
        domainStatus: 'PASS',
        mxStatus: 'PASS',
        smtpStatus: 'UNKNOWN',
        isCatchAll: false,
        isDisposable: false,
        isRole: false,
        verifiedAt: new Date(),
        expiresAt: new Date(Date.now() + 100000)
      });
    }

    // 1 SMTP_BLOCKED result
    await ListGuardStore.createResult(prisma, {
      jobId: testJobId,
      email: 'blocked@test.com',
      normalizedEmail: 'blocked@test.com',
      result: 'UNKNOWN',
      verificationReason: 'SMTP_BLOCKED',
      confidence: 'LOW',
      syntaxStatus: 'PASS',
      domainStatus: 'PASS',
      mxStatus: 'PASS',
      smtpStatus: 'UNKNOWN',
      isCatchAll: false,
      isDisposable: false,
      isRole: false,
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 100000)
    });

    const breakdown = await ListGuardStore.getJobUnknownReasonDistribution(prisma, testJobId);
    assert.strictEqual(breakdown['SMTP_TIMEOUT'], 2);
    assert.strictEqual(breakdown['SMTP_BLOCKED'], 1);
  });

  console.log(`\nTEST RUN COMPLETE: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
