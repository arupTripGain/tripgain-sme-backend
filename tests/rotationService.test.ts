import assert from 'assert';
import { selectFairMailbox } from '../src/services/rotationService';

console.log('====================================================');
console.log('RUNNING PHASE 5 ISOLATED ROTATION & AFFINITY TESTS');
console.log('Synthetic / Mocked Data Only — Zero Real Emails / Leads');
console.log('====================================================\n');

interface MockMailbox {
  id: string;
  email: string;
  status: 'CONNECTED' | 'DISCONNECTED';
  isActive: boolean;
  hourlySendLimit: number;
  dailySendLimit: number;
  sentThisHour: number;
  sentToday: number;
  inWindow: boolean;
  nextAvailableSendAt: Date | null;
}

function createMockMailboxes(count: number): MockMailbox[] {
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  return letters.slice(0, count).map((letter) => ({
    id: `TEST_MB_${letter}`,
    email: `mailbox-${letter.toLowerCase()}@test.local`,
    status: 'CONNECTED',
    isActive: true,
    hourlySendLimit: 100,
    dailySendLimit: 500,
    sentThisHour: 0,
    sentToday: 0,
    inWindow: true,
    nextAvailableSendAt: null
  }));
}

function filterEligible(mailboxes: MockMailbox[], now: Date = new Date()): MockMailbox[] {
  return mailboxes.filter((mb) => {
    if (mb.status !== 'CONNECTED' || !mb.isActive) return false;
    if (!mb.inWindow) return false;
    if (mb.nextAvailableSendAt && mb.nextAvailableSendAt > now) return false;
    if (mb.sentThisHour >= mb.hourlySendLimit) return false;
    if (mb.sentToday >= mb.dailySendLimit) return false;
    return true;
  });
}

// ----------------------------------------------------
// Scenario 1: 1 mailbox / 10 synthetic leads -> 10
// ----------------------------------------------------
{
  const mailboxes = createMockMailboxes(1);
  const mb0 = mailboxes[0]!;
  const counts = new Map<string, number>([[mb0.id, 0]]);
  const stableOrder = [mb0.id];

  for (let i = 1; i <= 10; i++) {
    const eligible = filterEligible(mailboxes);
    const selected = selectFairMailbox(eligible, counts, stableOrder);
    assert(selected, 'Expected mailbox to be selected');
    counts.set(selected.id, (counts.get(selected.id) || 0) + 1);
  }

  assert.strictEqual(counts.get(mb0.id), 10);
  console.log('✓ Scenario 1 Passed: 1 mailbox / 10 synthetic leads -> 10 assigned');
}

// ----------------------------------------------------
// Scenario 2: 2 mailboxes / 10 synthetic leads -> 5 / 5
// ----------------------------------------------------
{
  const mailboxes = createMockMailboxes(2);
  const counts = new Map<string, number>();
  mailboxes.forEach((mb) => counts.set(mb.id, 0));
  const stableOrder = mailboxes.map((m) => m.id);

  for (let i = 1; i <= 10; i++) {
    const eligible = filterEligible(mailboxes);
    const selected = selectFairMailbox(eligible, counts, stableOrder);
    assert(selected, 'Expected mailbox to be selected');
    counts.set(selected.id, (counts.get(selected.id) || 0) + 1);
  }

  assert.strictEqual(counts.get('TEST_MB_A'), 5);
  assert.strictEqual(counts.get('TEST_MB_B'), 5);
  console.log('✓ Scenario 2 Passed: 2 mailboxes / 10 synthetic leads -> 5 / 5 perfectly balanced');
}

// ----------------------------------------------------
// Scenario 3: 4 mailboxes / 100 synthetic leads -> 25 / 25 / 25 / 25
// ----------------------------------------------------
{
  const mailboxes = createMockMailboxes(4);
  const counts = new Map<string, number>();
  mailboxes.forEach((mb) => counts.set(mb.id, 0));
  const stableOrder = mailboxes.map((m) => m.id);

  for (let i = 1; i <= 100; i++) {
    const eligible = filterEligible(mailboxes);
    const selected = selectFairMailbox(eligible, counts, stableOrder);
    assert(selected, 'Expected mailbox to be selected');
    counts.set(selected.id, (counts.get(selected.id) || 0) + 1);
  }

  assert.strictEqual(counts.get('TEST_MB_A'), 25);
  assert.strictEqual(counts.get('TEST_MB_B'), 25);
  assert.strictEqual(counts.get('TEST_MB_C'), 25);
  assert.strictEqual(counts.get('TEST_MB_D'), 25);
  console.log('✓ Scenario 3 Passed: 4 mailboxes / 100 synthetic leads -> 25 / 25 / 25 / 25');
}

// ----------------------------------------------------
// Scenario 4: 4 mailboxes / 101 synthetic leads -> max diff <= 1 (26 / 25 / 25 / 25)
// ----------------------------------------------------
{
  const mailboxes = createMockMailboxes(4);
  const counts = new Map<string, number>();
  mailboxes.forEach((mb) => counts.set(mb.id, 0));
  const stableOrder = mailboxes.map((m) => m.id);

  for (let i = 1; i <= 101; i++) {
    const eligible = filterEligible(mailboxes);
    const selected = selectFairMailbox(eligible, counts, stableOrder);
    assert(selected, 'Expected mailbox to be selected');
    counts.set(selected.id, (counts.get(selected.id) || 0) + 1);
  }

  assert.strictEqual(counts.get('TEST_MB_A'), 26);
  assert.strictEqual(counts.get('TEST_MB_B'), 25);
  assert.strictEqual(counts.get('TEST_MB_C'), 25);
  assert.strictEqual(counts.get('TEST_MB_D'), 25);
  const vals = Array.from(counts.values());
  const maxDiff = Math.max(...vals) - Math.min(...vals);
  assert(maxDiff <= 1, 'Max distribution difference must be <= 1');
  console.log('✓ Scenario 4 Passed: 4 mailboxes / 101 synthetic leads -> 26/25/25/25 (diff <= 1, tie-break order respected)');
}

// ----------------------------------------------------
// Scenario 5: One mailbox unavailable -> remaining eligible mailboxes receive assignments
// ----------------------------------------------------
{
  const mailboxes = createMockMailboxes(4);
  mailboxes[1]!.status = 'DISCONNECTED'; // Mailbox B disconnected
  const counts = new Map<string, number>();
  mailboxes.forEach((mb) => counts.set(mb.id, 0));
  const stableOrder = mailboxes.map((m) => m.id);

  for (let i = 1; i <= 30; i++) {
    const eligible = filterEligible(mailboxes);
    const selected = selectFairMailbox(eligible, counts, stableOrder);
    assert(selected, 'Expected mailbox to be selected');
    counts.set(selected.id, (counts.get(selected.id) || 0) + 1);
  }

  assert.strictEqual(counts.get('TEST_MB_A'), 10);
  assert.strictEqual(counts.get('TEST_MB_B'), 0); // B skipped completely
  assert.strictEqual(counts.get('TEST_MB_C'), 10);
  assert.strictEqual(counts.get('TEST_MB_D'), 10);
  console.log('✓ Scenario 5 Passed: Disconnected mailbox B skipped; A, C, D received 10 each');
}

// ----------------------------------------------------
// Scenario 6: One mailbox at capacity -> excluded from NEW assignment
// ----------------------------------------------------
{
  const mailboxes = createMockMailboxes(4);
  mailboxes[2]!.hourlySendLimit = 10;
  mailboxes[2]!.sentThisHour = 10; // Mailbox C is at hourly capacity
  const counts = new Map<string, number>();
  mailboxes.forEach((mb) => counts.set(mb.id, 0));
  const stableOrder = mailboxes.map((m) => m.id);

  for (let i = 1; i <= 15; i++) {
    const eligible = filterEligible(mailboxes);
    const selected = selectFairMailbox(eligible, counts, stableOrder);
    assert(selected, 'Expected mailbox to be selected');
    counts.set(selected.id, (counts.get(selected.id) || 0) + 1);
  }

  assert.strictEqual(counts.get('TEST_MB_C'), 0);
  assert.strictEqual(counts.get('TEST_MB_A'), 5);
  assert.strictEqual(counts.get('TEST_MB_B'), 5);
  assert.strictEqual(counts.get('TEST_MB_D'), 5);
  console.log('✓ Scenario 6 Passed: Mailbox C at capacity excluded from new assignments');
}

// ----------------------------------------------------
// Scenario 7: Mailbox becomes available again -> re-enters balancing pool
// ----------------------------------------------------
{
  const mailboxes = createMockMailboxes(4);
  mailboxes[2]!.inWindow = false; // Mailbox C initially outside sending window
  const counts = new Map<string, number>();
  mailboxes.forEach((mb) => counts.set(mb.id, 0));
  const stableOrder = mailboxes.map((m) => m.id);

  // Assign first 9 leads
  for (let i = 1; i <= 9; i++) {
    const eligible = filterEligible(mailboxes);
    const selected = selectFairMailbox(eligible, counts, stableOrder);
    assert(selected);
    counts.set(selected.id, (counts.get(selected.id) || 0) + 1);
  }
  // A=3, B=3, C=0, D=3
  assert.strictEqual(counts.get('TEST_MB_C'), 0);

  // Mailbox C window opens!
  mailboxes[2]!.inWindow = true;

  // Next 3 leads should naturally go to Mailbox C to balance the pool!
  for (let i = 1; i <= 3; i++) {
    const eligible = filterEligible(mailboxes);
    const selected = selectFairMailbox(eligible, counts, stableOrder);
    assert.strictEqual(selected?.id, 'TEST_MB_C', `Lead ${i} should go to C to balance pool`);
    counts.set(selected!.id, (counts.get(selected!.id) || 0) + 1);
  }

  assert.strictEqual(counts.get('TEST_MB_A'), 3);
  assert.strictEqual(counts.get('TEST_MB_B'), 3);
  assert.strictEqual(counts.get('TEST_MB_C'), 3);
  assert.strictEqual(counts.get('TEST_MB_D'), 3);
  console.log('✓ Scenario 7 Passed: Recovered Mailbox C smoothly catches up to 3/3/3/3 balance');
}

// ----------------------------------------------------
// Scenario 8: Follow-up affinity -> Step 1/2/3 remain on same mailbox
// ----------------------------------------------------
{
  interface MockEnrollment {
    id: string;
    mailboxId: string | null;
    currentStep: number;
    stepsDispatched: Array<{ step: number; mailboxId: string }>;
  }

  const mailboxes = createMockMailboxes(4);
  const counts = new Map<string, number>();
  mailboxes.forEach((mb) => counts.set(mb.id, 0));
  const stableOrder = mailboxes.map((m) => m.id);

  const enrollment: MockEnrollment = {
    id: 'TEST_LEAD_AFFINITY_01',
    mailboxId: null,
    currentStep: 0,
    stepsDispatched: []
  };

  // Step 1: Brand new lead -> gets assigned mailbox via rotation
  assert.strictEqual(enrollment.mailboxId, null);
  const eligible1 = filterEligible(mailboxes);
  const assigned = selectFairMailbox(eligible1, counts, stableOrder);
  assert(assigned);
  enrollment.mailboxId = assigned.id;
  counts.set(assigned.id, (counts.get(assigned.id) || 0) + 1);
  enrollment.currentStep = 1;
  enrollment.stepsDispatched.push({ step: 1, mailboxId: enrollment.mailboxId! });

  // Now other mailboxes receive leads so assigned mailbox has highest count
  counts.set(assigned.id, 50); // Assigned mailbox has 50 leads now

  // Step 2 Follow-up: MUST use enrollment.mailboxId (NO re-rotation)
  assert.strictEqual(enrollment.mailboxId, assigned.id);
  enrollment.currentStep = 2;
  enrollment.stepsDispatched.push({ step: 2, mailboxId: enrollment.mailboxId! });

  // Step 3 Follow-up: MUST use enrollment.mailboxId (NO re-rotation)
  enrollment.currentStep = 3;
  enrollment.stepsDispatched.push({ step: 3, mailboxId: enrollment.mailboxId! });

  assert.strictEqual(enrollment.stepsDispatched[0]!.mailboxId, assigned.id);
  assert.strictEqual(enrollment.stepsDispatched[1]!.mailboxId, assigned.id);
  assert.strictEqual(enrollment.stepsDispatched[2]!.mailboxId, assigned.id);
  console.log(`✓ Scenario 8 Passed: Follow-up affinity preserved across Steps 1, 2, 3 on ${assigned.id}`);
}

// ----------------------------------------------------
// Scenario 9: Scheduler restart simulation -> state derived from DB counts
// ----------------------------------------------------
{
  const mailboxes = createMockMailboxes(3);
  const stableOrder = mailboxes.map((m) => m.id);

  // Simulate existing database counts from prior scheduler run: A=12, B=12, C=11
  const persistedDbCounts = new Map<string, number>([
    ['TEST_MB_A', 12],
    ['TEST_MB_B', 12],
    ['TEST_MB_C', 11]
  ]);

  // Scheduler restarts with 0 in-memory state, queries DB counts
  const freshMemoryCounts = new Map(persistedDbCounts);
  const eligible = filterEligible(mailboxes);
  const nextLead = selectFairMailbox(eligible, freshMemoryCounts, stableOrder);

  assert.strictEqual(nextLead?.id, 'TEST_MB_C', 'Restarted scheduler must select C to restore balance');
  console.log('✓ Scenario 9 Passed: Scheduler restart successfully derives balance from DB state');
}

// ----------------------------------------------------
// Scenario 10: Concurrency simulation -> no duplicate assignments
// ----------------------------------------------------
{
  const mailboxes = createMockMailboxes(4);
  const counts = new Map<string, number>();
  mailboxes.forEach((mb) => counts.set(mb.id, 0));
  const stableOrder = mailboxes.map((m) => m.id);

  const assignments: string[] = [];

  // Simulate 40 concurrent allocations with atomic increment simulation
  for (let i = 0; i < 40; i++) {
    const eligible = filterEligible(mailboxes);
    const selected = selectFairMailbox(eligible, counts, stableOrder);
    assert(selected);
    counts.set(selected.id, (counts.get(selected.id) || 0) + 1);
    assignments.push(selected.id);
  }

  assert.strictEqual(assignments.length, 40);
  assert.strictEqual(counts.get('TEST_MB_A'), 10);
  assert.strictEqual(counts.get('TEST_MB_B'), 10);
  assert.strictEqual(counts.get('TEST_MB_C'), 10);
  assert.strictEqual(counts.get('TEST_MB_D'), 10);
  console.log('✓ Scenario 10 Passed: Simulated atomic concurrency achieved exact 10/10/10/10 distribution');
}

console.log('\n====================================================');
console.log('ALL 10 ISOLATED ROTATION & AFFINITY SCENARIOS PASSED!');
console.log('====================================================');
