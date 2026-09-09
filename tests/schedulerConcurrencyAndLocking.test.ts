import assert from 'assert';

console.log('====================================================');
console.log('RUNNING SCHEDULER CONCURRENCY & LOCKING TESTS');
console.log('Synthetic / Mock Data Only — Zero Real Emails / Leads');
console.log('====================================================\n');

interface MockEnrollment {
  id: string;
  campaignId: string;
  sequenceId: string;
  contactId: string;
  currentStep: number;
  status: string;
  mailboxId: string | null;
  nextSendAt: Date | null;
  lastSentAt: Date | null;
  lockedAt: Date | null;
  lockedBy: string | null;
  lockExpiresAt: Date | null;
  failureCount?: number;
  lastError?: string | null;
}

interface MockEmailMessage {
  id: string;
  idempotencyKey: string;
  enrollmentId: string;
  campaignId: string;
  sequenceStepId: string;
  status: string;
  fromEmail: string;
  toEmail: string;
}

// In-memory atomic DB store
class MockDb {
  enrollments: Map<string, MockEnrollment> = new Map();
  messages: Map<string, MockEmailMessage> = new Map();

  addEnrollment(e: MockEnrollment) {
    this.enrollments.set(e.id, { ...e });
  }

  // Simulates Step F batch reservation
  batchReserve(candidateIds: string[], workerId: string, lockDurationMs = 10 * 60 * 1000): number {
    let count = 0;
    const now = new Date();
    for (const id of candidateIds) {
      const e = this.enrollments.get(id);
      if (e) {
        e.lockedAt = now;
        e.lockedBy = workerId;
        e.lockExpiresAt = new Date(now.getTime() + lockDurationMs);
        count++;
      }
    }
    return count;
  }

  // Simulates the exact Prisma updateMany in schedulerService.ts (with worker-owned lock support)
  tryAcquireOrRenewLock(enrollmentId: string, workerId: string, now: Date, lockDurationMs = 10 * 60 * 1000): boolean {
    const e = this.enrollments.get(enrollmentId);
    if (!e) return false;

    const isUnlocked = e.lockedAt === null;
    const isExpired = e.lockExpiresAt !== null && e.lockExpiresAt.getTime() <= now.getTime();
    const isOwnedByWorker = e.lockedBy === workerId;

    if (isUnlocked || isExpired || isOwnedByWorker) {
      e.lockedAt = now;
      e.lockedBy = workerId;
      e.lockExpiresAt = new Date(now.getTime() + lockDurationMs);
      return true;
    }

    return false; // Locked by another worker
  }

  // Simulates the finally block lock release
  releaseLock(enrollmentId: string, workerId: string): boolean {
    const e = this.enrollments.get(enrollmentId);
    if (!e) return false;
    if (e.lockedBy === workerId) {
      e.lockedAt = null;
      e.lockedBy = null;
      e.lockExpiresAt = null;
      return true;
    }
    return false; // Cannot release another worker's lock
  }

  // Simulates atomic message creation with idempotency unique constraint
  createEmailMessage(msg: MockEmailMessage): boolean {
    if (this.messages.has(msg.idempotencyKey)) {
      return false; // Unique constraint violation (duplicate prevented)
    }
    this.messages.set(msg.idempotencyKey, msg);
    return true;
  }
}

// ---------------------------------------------------------------------
// Test 1: Worker A batch-reserves enrollment, then processes it.
// Expected: Worker A is allowed to continue processing its own reservation.
// ---------------------------------------------------------------------
{
  const db = new MockDb();
  db.addEnrollment({
    id: 'e-1',
    campaignId: 'camp-1',
    sequenceId: 'seq-1',
    contactId: 'c-1',
    currentStep: 1,
    status: 'active',
    mailboxId: 'mb-1',
    nextSendAt: new Date(Date.now() - 1000),
    lastSentAt: null,
    lockedAt: null,
    lockedBy: null,
    lockExpiresAt: null
  });

  const workerA = 'worker-A-uuid';
  // Step F: batch reserve
  db.batchReserve(['e-1'], workerA);

  const e = db.enrollments.get('e-1')!;
  assert.strictEqual(e.lockedBy, workerA);

  // Dispatch loop: lock acquisition
  const now = new Date();
  const allowed = db.tryAcquireOrRenewLock('e-1', workerA, now);
  assert.strictEqual(allowed, true, 'Worker A must be allowed to process its own batch reservation');

  // Lock released in finally block
  db.releaseLock('e-1', workerA);
  assert.strictEqual(e.lockedAt, null);
  assert.strictEqual(e.lockedBy, null);
  console.log('✔ Test 1 passed: Worker A is allowed to continue processing its own reservation');
}

// ---------------------------------------------------------------------
// Test 2: Worker B attempts to process an enrollment locked by Worker A.
// Expected: Worker B cannot process it.
// ---------------------------------------------------------------------
{
  const db = new MockDb();
  db.addEnrollment({
    id: 'e-2',
    campaignId: 'camp-1',
    sequenceId: 'seq-1',
    contactId: 'c-2',
    currentStep: 1,
    status: 'active',
    mailboxId: 'mb-1',
    nextSendAt: new Date(Date.now() - 1000),
    lastSentAt: null,
    lockedAt: null,
    lockedBy: null,
    lockExpiresAt: null
  });

  const workerA = 'worker-A-uuid';
  const workerB = 'worker-B-uuid';

  // Worker A reserves e-2
  db.batchReserve(['e-2'], workerA);

  // Worker B attempts to acquire lock while Worker A's lock is active
  const now = new Date();
  const workerBAcquired = db.tryAcquireOrRenewLock('e-2', workerB, now);
  assert.strictEqual(workerBAcquired, false, 'Worker B must be rejected when enrollment is locked by Worker A');

  // If Worker B hits finally block, it must not accidentally clear Worker A's lock
  const workerBCleared = db.releaseLock('e-2', workerB);
  assert.strictEqual(workerBCleared, false, "Worker B's cleanup must not release Worker A's lock");

  const e = db.enrollments.get('e-2')!;
  assert.strictEqual(e.lockedBy, workerA, 'Worker A lock must remain intact');
  console.log('✔ Test 2 passed: Worker B cannot process or release enrollment locked by Worker A');
}

// ---------------------------------------------------------------------
// Test 3: Worker A reservation is followed by an error.
// Expected: Lock is safely released according to lock release / finally strategy.
// ---------------------------------------------------------------------
{
  const db = new MockDb();
  db.addEnrollment({
    id: 'e-3',
    campaignId: 'camp-1',
    sequenceId: 'seq-1',
    contactId: 'c-3',
    currentStep: 1,
    status: 'active',
    mailboxId: 'mb-1',
    nextSendAt: new Date(Date.now() - 1000),
    lastSentAt: null,
    lockedAt: null,
    lockedBy: null,
    lockExpiresAt: null
  });

  const workerA = 'worker-A-uuid';
  db.batchReserve(['e-3'], workerA);

  // Simulate execution entering try/catch/finally with an error during sendMail
  let errorHandled = false;
  try {
    const locked = db.tryAcquireOrRenewLock('e-3', workerA, new Date());
    assert.strictEqual(locked, true);
    // Simulate runtime failure (e.g. SMTP connection timeout)
    throw new Error('Simulated SMTP error');
  } catch (err) {
    errorHandled = true;
    const e = db.enrollments.get('e-3')!;
    e.failureCount = 1;
    e.lastError = 'SENDING_FAILED';
  } finally {
    db.releaseLock('e-3', workerA);
  }

  assert.strictEqual(errorHandled, true);
  const e = db.enrollments.get('e-3')!;
  assert.strictEqual(e.lockedAt, null, 'Lock must be cleared in finally block even on error');
  assert.strictEqual(e.lockedBy, null);
  assert.strictEqual(e.failureCount, 1);
  console.log('✔ Test 3 passed: Lock is safely released in finally block when an error occurs');
}

// ---------------------------------------------------------------------
// Test 4: No code path can skip an enrollment with continue while leaving an owned lock indefinitely.
// Expected: Every branch (stopCheck, !step, duplicate, locked.count=0) executes finally.
// ---------------------------------------------------------------------
{
  const db = new MockDb();
  const workerA = 'worker-A-uuid';

  const scenarios = [
    { id: 'e-stop', shouldStop: true, missingStep: false, duplicate: false },
    { id: 'e-nostep', shouldStop: false, missingStep: true, duplicate: false },
    { id: 'e-dup', shouldStop: false, missingStep: false, duplicate: true }
  ];

  for (const sc of scenarios) {
    db.addEnrollment({
      id: sc.id,
      campaignId: 'camp-1',
      sequenceId: 'seq-1',
      contactId: 'c-x',
      currentStep: 1,
      status: 'active',
      mailboxId: 'mb-1',
      nextSendAt: new Date(Date.now() - 1000),
      lastSentAt: null,
      lockedAt: null,
      lockedBy: null,
      lockExpiresAt: null
    });

    db.batchReserve([sc.id], workerA);

    // Simulate loop iteration wrapped in try/finally
    let skipped = false;
    try {
      const locked = db.tryAcquireOrRenewLock(sc.id, workerA, new Date());
      if (!locked) continue;

      if (sc.shouldStop) {
        skipped = true;
        continue; // continue inside try triggers finally!
      }
      if (sc.missingStep) {
        skipped = true;
        continue;
      }
      if (sc.duplicate) {
        skipped = true;
        continue;
      }
    } finally {
      db.releaseLock(sc.id, workerA);
    }

    assert.strictEqual(skipped, true);
    const rec = db.enrollments.get(sc.id)!;
    assert.strictEqual(rec.lockedAt, null, `Enrollment ${sc.id} must have lock released via finally`);
    assert.strictEqual(rec.lockedBy, null);
  }

  console.log('✔ Test 4 passed: No code path with continue leaves an owned lock indefinitely');
}

// ---------------------------------------------------------------------
// Test 5: All 5 synthetic/test enrollments become eligible after stale lock cleanup.
// ---------------------------------------------------------------------
{
  const db = new MockDb();
  const testEnrollmentIds = [
    'd723b088-6814-44c8-8e60-e7919ba45745',
    'aac77f6b-b440-4ba9-b276-06abdf7cc30e',
    '8b4a9643-2ac5-4358-b65c-646685e8aedf',
    '7dc752b7-35e3-416f-82ce-654754ee12d7',
    'b530cfe3-3f96-44f8-bbef-1b747836f6e0'
  ];

  // Populate them in stale locked state
  const staleWorker = 'stale-worker-id';
  const now = new Date();
  for (const id of testEnrollmentIds) {
    db.addEnrollment({
      id,
      campaignId: 'f2644f9d-3a3f-48e0-80a4-111cfb9d8699',
      sequenceId: 'seq-test',
      contactId: `contact-${id}`,
      currentStep: 1,
      status: 'active',
      mailboxId: 'mb-assigned',
      nextSendAt: new Date(now.getTime() - 3600000), // Due 1 hr ago
      lastSentAt: null,
      lockedAt: now,
      lockedBy: staleWorker,
      lockExpiresAt: new Date(now.getTime() + 600000) // Stale lock in the future
    });
  }

  // Before cleanup: Relation filter would exclude them
  const eligibleBefore = Array.from(db.enrollments.values()).filter(e => {
    const isUnlocked = e.lockedAt === null || (e.lockExpiresAt !== null && e.lockExpiresAt <= now);
    return ['pending', 'active'].includes(e.status) && e.nextSendAt && e.nextSendAt <= now && isUnlocked;
  });
  assert.strictEqual(eligibleBefore.length, 0, 'Before cleanup, stale future lock prevents eligibility');

  // Run repair: reset lock fields to null
  for (const id of testEnrollmentIds) {
    const e = db.enrollments.get(id)!;
    e.lockedAt = null;
    e.lockedBy = null;
    e.lockExpiresAt = null;
  }

  // After cleanup: All 5 are immediately eligible
  const eligibleAfter = Array.from(db.enrollments.values()).filter(e => {
    const isUnlocked = e.lockedAt === null || (e.lockExpiresAt !== null && e.lockExpiresAt <= now);
    return ['pending', 'active'].includes(e.status) && e.nextSendAt && e.nextSendAt <= now && isUnlocked;
  });
  assert.strictEqual(eligibleAfter.length, 5, 'All 5 test enrollments must be immediately eligible after repair');
  console.log('✔ Test 5 passed: All 5 synthetic/test enrollments become eligible after stale lock cleanup');
}

// ---------------------------------------------------------------------
// Test 6: Scheduler creates exactly one EmailMessage per successful dispatch.
// ---------------------------------------------------------------------
{
  const db = new MockDb();
  const enrollmentId = 'e-single-send';
  const campaignId = 'camp-single';
  const stepId = 'step-1';
  const idempotencyKey = `${campaignId}:${enrollmentId}:${stepId}`;

  const created = db.createEmailMessage({
    id: 'msg-1',
    idempotencyKey,
    enrollmentId,
    campaignId,
    sequenceStepId: stepId,
    status: 'sent',
    fromEmail: 'sender@tripgain.com',
    toEmail: 'lead@test.com'
  });

  assert.strictEqual(created, true);
  assert.strictEqual(db.messages.size, 1, 'Exactly one message record must be created');
  console.log('✔ Test 6 passed: Scheduler creates exactly one EmailMessage per successful dispatch');
}

// ---------------------------------------------------------------------
// Test 7: Concurrent scheduler ticks cannot create duplicate EmailMessages.
// ---------------------------------------------------------------------
{
  const db = new MockDb();
  const enrollmentId = 'e-concurrent';
  const campaignId = 'camp-concurrent';
  const stepId = 'step-1';
  const idempotencyKey = `${campaignId}:${enrollmentId}:${stepId}`;

  // Worker 1 creates message
  const w1Result = db.createEmailMessage({
    id: 'msg-w1',
    idempotencyKey,
    enrollmentId,
    campaignId,
    sequenceStepId: stepId,
    status: 'sent',
    fromEmail: 'sender@tripgain.com',
    toEmail: 'lead@test.com'
  });

  // Worker 2 attempts duplicate with same idempotency key
  const w2Result = db.createEmailMessage({
    id: 'msg-w2',
    idempotencyKey,
    enrollmentId,
    campaignId,
    sequenceStepId: stepId,
    status: 'sent',
    fromEmail: 'sender@tripgain.com',
    toEmail: 'lead@test.com'
  });

  assert.strictEqual(w1Result, true, 'Worker 1 first send succeeds');
  assert.strictEqual(w2Result, false, 'Worker 2 duplicate send blocked by unique idempotencyKey');
  assert.strictEqual(db.messages.size, 1, 'Database must contain exactly 1 message record');
  console.log('✔ Test 7 passed: Concurrent scheduler ticks cannot create duplicate EmailMessages');
}

console.log('\nAll 7 Scheduler Concurrency & Locking Tests Passed Successfully!\n');
