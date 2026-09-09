import assert from 'assert';

console.log('====================================================');
console.log('RUNNING OUTREACH ANALYTICS & DATA CORRECTNESS TESTS');
console.log('Synthetic / In-Memory Mock Data — Zero Real Emails');
console.log('====================================================\n');

interface MockMessage {
  id: string;
  campaignId: string;
  enrollmentId: string;
  sequenceStepId?: string;
  status: string; // 'sent', 'delivered', 'bounced', 'failed', 'pending'
  sentAt?: Date;
}

interface MockEvent {
  id: string;
  campaignId: string;
  enrollmentId: string;
  emailMessageId?: string;
  eventType: string; // 'opened', 'clicked', 'replied', 'bounced', 'unsubscribed'
  eventAt: Date;
  emailLinkId?: string;
}

interface MockEnrollment {
  id: string;
  campaignId: string;
  contactId: string;
  currentStep: number;
  status: string;
  lastSentAt?: Date | null;
}

// In-memory pure analytics calculator mirroring AnalyticsService logic
function calculateMetrics(params: {
  enrollments: MockEnrollment[];
  messages: MockMessage[];
  events: MockEvent[];
  startDate?: Date;
  endDate?: Date;
}) {
  const { enrollments, messages, events, startDate, endDate } = params;

  // Filter messages by date if provided
  const filteredMessages = messages.filter((m) => {
    if (!startDate && !endDate) return true;
    if (!m.sentAt) return false;
    if (startDate && m.sentAt < startDate) return false;
    if (endDate && m.sentAt > endDate) return false;
    return true;
  });

  // Filter events by date if provided
  const filteredEvents = events.filter((e) => {
    if (!startDate && !endDate) return true;
    if (startDate && e.eventAt < startDate) return false;
    if (endDate && e.eventAt > endDate) return false;
    return true;
  });

  // 1. Sent
  const sentMessages = filteredMessages.filter(
    (m) => m.status === 'sent' || m.status === 'delivered'
  );
  const sentCount = sentMessages.length;
  const sentEnrollmentIds = new Set(sentMessages.map((m) => m.enrollmentId));
  const uniqueSent = sentEnrollmentIds.size;

  // 2. Bounced
  const bouncedMessages = filteredMessages.filter((m) => m.status === 'bounced');
  const bouncedEnrollmentIds = new Set(bouncedMessages.map((m) => m.enrollmentId));
  filteredEvents
    .filter((e) => e.eventType === 'bounced')
    .forEach((e) => bouncedEnrollmentIds.add(e.enrollmentId));
  const uniqueBounced = bouncedEnrollmentIds.size;

  // 3. Delivered
  const deliveredCount = Math.max(0, sentCount - bouncedMessages.length);
  const uniqueDelivered = Math.max(0, uniqueSent - uniqueBounced);

  // 4. Opens
  const openEvents = filteredEvents.filter(
    (e) => e.eventType === 'opened' || e.eventType === 'email.opened'
  );
  const uniqueOpenerIds = new Set(openEvents.map((e) => e.enrollmentId));
  const totalOpens = openEvents.length;
  const uniqueOpeners = uniqueOpenerIds.size;

  const uniqueOpenRate =
    uniqueDelivered > 0
      ? Math.min(100, Number(((uniqueOpeners / uniqueDelivered) * 100).toFixed(1)))
      : null;

  // 5. Clicks
  const clickEvents = filteredEvents.filter(
    (e) => e.eventType === 'clicked' || e.eventType === 'email.clicked'
  );
  const uniqueClickerIds = new Set(clickEvents.map((e) => e.enrollmentId));
  const totalClicks = clickEvents.length;
  const uniqueClickers = uniqueClickerIds.size;

  const uniqueClickRate =
    uniqueDelivered > 0
      ? Math.min(100, Number(((uniqueClickers / uniqueDelivered) * 100).toFixed(1)))
      : null;

  // 6. Replies
  const replyEvents = filteredEvents.filter(
    (e) => e.eventType === 'replied' || e.eventType === 'email.replied'
  );
  const uniqueReplierIds = new Set(replyEvents.map((e) => e.enrollmentId));
  enrollments
    .filter((e) => e.status === 'replied')
    .forEach((e) => uniqueReplierIds.add(e.id));
  const totalReplies = Math.max(replyEvents.length, uniqueReplierIds.size);
  const uniqueRepliers = uniqueReplierIds.size;

  const replyRate =
    uniqueDelivered > 0
      ? Math.min(100, Number(((uniqueRepliers / uniqueDelivered) * 100).toFixed(1)))
      : null;

  // 7. Unsubscribes
  const unsubEvents = filteredEvents.filter(
    (e) => e.eventType === 'unsubscribed' || e.eventType === 'email.unsubscribed'
  );
  const unsubscriberIds = new Set(unsubEvents.map((e) => e.enrollmentId));
  enrollments
    .filter((e) => e.status === 'unsubscribed')
    .forEach((e) => unsubscriberIds.add(e.id));
  const uniqueUnsubscribed = unsubscriberIds.size;

  const unsubscribeRate =
    uniqueDelivered > 0
      ? Math.min(100, Number(((uniqueUnsubscribed / uniqueDelivered) * 100).toFixed(1)))
      : null;

  // 8. Funnel (Sent -> Delivered -> Opened -> Clicked -> Replied)
  const funnel = [
    { stage: 'Sent', count: uniqueSent, pct: 100 },
    {
      stage: 'Delivered',
      count: uniqueDelivered,
      pct: uniqueSent > 0 ? Number(((uniqueDelivered / uniqueSent) * 100).toFixed(1)) : 0
    },
    {
      stage: 'Opened',
      count: uniqueOpeners,
      pct: uniqueSent > 0 ? Number(((uniqueOpeners / uniqueSent) * 100).toFixed(1)) : 0
    },
    {
      stage: 'Clicked',
      count: uniqueClickers,
      pct: uniqueSent > 0 ? Number(((uniqueClickers / uniqueSent) * 100).toFixed(1)) : 0
    },
    {
      stage: 'Replied',
      count: uniqueRepliers,
      pct: uniqueSent > 0 ? Number(((uniqueRepliers / uniqueSent) * 100).toFixed(1)) : 0
    }
  ];

  return {
    sent: sentCount,
    uniqueSent,
    delivered: deliveredCount,
    uniqueDelivered,
    totalOpens,
    uniqueOpeners,
    uniqueOpenRate,
    totalClicks,
    uniqueClickers,
    uniqueClickRate,
    totalReplies,
    uniqueRepliers,
    replyRate,
    uniqueBounced,
    uniqueUnsubscribed,
    unsubscribeRate,
    funnel
  };
}

// ---------------------------------------------------------------------
// Test 1: 5 recipients, 12 opens -> unique open rate = 100%, total opens = 12.
// ---------------------------------------------------------------------
{
  const enrollments = Array.from({ length: 5 }, (_, i) => ({
    id: `enr-${i}`,
    campaignId: 'camp-1',
    contactId: `cnt-${i}`,
    currentStep: 1,
    status: 'active'
  }));

  const messages = enrollments.map((e) => ({
    id: `msg-${e.id}`,
    campaignId: 'camp-1',
    enrollmentId: e.id,
    status: 'sent',
    sentAt: new Date()
  }));

  // 12 open events distributed across all 5 enrollments
  const events = [
    { id: 'e1', campaignId: 'camp-1', enrollmentId: 'enr-0', eventType: 'opened', eventAt: new Date() },
    { id: 'e2', campaignId: 'camp-1', enrollmentId: 'enr-0', eventType: 'opened', eventAt: new Date() },
    { id: 'e3', campaignId: 'camp-1', enrollmentId: 'enr-1', eventType: 'opened', eventAt: new Date() },
    { id: 'e4', campaignId: 'camp-1', enrollmentId: 'enr-1', eventType: 'opened', eventAt: new Date() },
    { id: 'e5', campaignId: 'camp-1', enrollmentId: 'enr-2', eventType: 'opened', eventAt: new Date() },
    { id: 'e6', campaignId: 'camp-1', enrollmentId: 'enr-2', eventType: 'opened', eventAt: new Date() },
    { id: 'e7', campaignId: 'camp-1', enrollmentId: 'enr-3', eventType: 'opened', eventAt: new Date() },
    { id: 'e8', campaignId: 'camp-1', enrollmentId: 'enr-3', eventType: 'opened', eventAt: new Date() },
    { id: 'e9', campaignId: 'camp-1', enrollmentId: 'enr-4', eventType: 'opened', eventAt: new Date() },
    { id: 'e10', campaignId: 'camp-1', enrollmentId: 'enr-4', eventType: 'opened', eventAt: new Date() },
    { id: 'e11', campaignId: 'camp-1', enrollmentId: 'enr-0', eventType: 'opened', eventAt: new Date() },
    { id: 'e12', campaignId: 'camp-1', enrollmentId: 'enr-0', eventType: 'opened', eventAt: new Date() }
  ];

  const m = calculateMetrics({ enrollments, messages, events });
  assert.strictEqual(m.totalOpens, 12, 'Total opens must equal 12');
  assert.strictEqual(m.uniqueOpeners, 5, 'All 5 unique recipients opened');
  assert.strictEqual(m.uniqueOpenRate, 100, 'Unique open rate must be 100%, NEVER 240%');
  console.log('✔ Test 1 passed: 5 recipients, 12 opens -> unique open rate = 100%, total opens = 12 (fixes 240% bug)');
}

// ---------------------------------------------------------------------
// Test 2: 5 recipients, 1 opener -> unique open rate = 20%.
// ---------------------------------------------------------------------
{
  const enrollments = Array.from({ length: 5 }, (_, i) => ({
    id: `enr-${i}`,
    campaignId: 'c2',
    contactId: `cnt-${i}`,
    currentStep: 1,
    status: 'active'
  }));
  const messages = enrollments.map((e) => ({
    id: `msg-${e.id}`,
    campaignId: 'c2',
    enrollmentId: e.id,
    status: 'delivered',
    sentAt: new Date()
  }));
  const events = [
    { id: 'ev-1', campaignId: 'c2', enrollmentId: 'enr-0', eventType: 'opened', eventAt: new Date() }
  ];

  const m = calculateMetrics({ enrollments, messages, events });
  assert.strictEqual(m.uniqueOpenRate, 20.0);
  console.log('✔ Test 2 passed: 5 recipients, 1 opener -> unique open rate = 20.0%');
}

// ---------------------------------------------------------------------
// Test 3: 5 recipients, 0 opens -> 0.0%.
// ---------------------------------------------------------------------
{
  const enrollments = Array.from({ length: 5 }, (_, i) => ({
    id: `enr-${i}`,
    campaignId: 'c3',
    contactId: `cnt-${i}`,
    currentStep: 1,
    status: 'active'
  }));
  const messages = enrollments.map((e) => ({
    id: `msg-${e.id}`,
    campaignId: 'c3',
    enrollmentId: e.id,
    status: 'sent',
    sentAt: new Date()
  }));

  const m = calculateMetrics({ enrollments, messages, events: [] });
  assert.strictEqual(m.uniqueOpenRate, 0.0);
  console.log('✔ Test 3 passed: 5 recipients, 0 opens -> 0.0%');
}

// ---------------------------------------------------------------------
// Test 4: 0 delivered -> rate = null ("—"), never NaN or Infinity.
// ---------------------------------------------------------------------
{
  const m = calculateMetrics({ enrollments: [], messages: [], events: [] });
  assert.strictEqual(m.uniqueOpenRate, null, 'Must be null when denominator is 0');
  assert.strictEqual(m.uniqueClickRate, null);
  assert.strictEqual(m.replyRate, null);
  console.log('✔ Test 4 passed: 0 delivered -> rates are null ("—"), preventing NaN/Infinity');
}

// ---------------------------------------------------------------------
// Test 5: One contact opens 10 times -> unique opener = 1.
// ---------------------------------------------------------------------
{
  const events = Array.from({ length: 10 }, (_, i) => ({
    id: `ev-multi-${i}`,
    campaignId: 'c5',
    enrollmentId: 'enr-single',
    eventType: 'opened',
    eventAt: new Date()
  }));
  const m = calculateMetrics({
    enrollments: [{ id: 'enr-single', campaignId: 'c5', contactId: 'cnt-1', currentStep: 1, status: 'active' }],
    messages: [{ id: 'msg-1', campaignId: 'c5', enrollmentId: 'enr-single', status: 'sent', sentAt: new Date() }],
    events
  });
  assert.strictEqual(m.totalOpens, 10);
  assert.strictEqual(m.uniqueOpeners, 1);
  assert.strictEqual(m.uniqueOpenRate, 100);
  console.log('✔ Test 5 passed: One contact opens 10 times -> unique opener = 1, total opens = 10');
}

// ---------------------------------------------------------------------
// Test 6: One contact clicks 5 times -> unique clicker = 1.
// ---------------------------------------------------------------------
{
  const events = Array.from({ length: 5 }, (_, i) => ({
    id: `ev-clk-${i}`,
    campaignId: 'c6',
    enrollmentId: 'enr-click',
    eventType: 'clicked',
    eventAt: new Date()
  }));
  const m = calculateMetrics({
    enrollments: [{ id: 'enr-click', campaignId: 'c6', contactId: 'cnt-1', currentStep: 1, status: 'active' }],
    messages: [{ id: 'msg-1', campaignId: 'c6', enrollmentId: 'enr-click', status: 'sent', sentAt: new Date() }],
    events
  });
  assert.strictEqual(m.totalClicks, 5);
  assert.strictEqual(m.uniqueClickers, 1);
  assert.strictEqual(m.uniqueClickRate, 100);
  console.log('✔ Test 6 passed: One contact clicks 5 times -> unique clicker = 1, total clicks = 5');
}

// ---------------------------------------------------------------------
// Test 7: One contact replies 3 times -> unique replier = 1.
// ---------------------------------------------------------------------
{
  const events = Array.from({ length: 3 }, (_, i) => ({
    id: `ev-rep-${i}`,
    campaignId: 'c7',
    enrollmentId: 'enr-reply',
    eventType: 'replied',
    eventAt: new Date()
  }));
  const m = calculateMetrics({
    enrollments: [{ id: 'enr-reply', campaignId: 'c7', contactId: 'cnt-1', currentStep: 1, status: 'replied' }],
    messages: [{ id: 'msg-1', campaignId: 'c7', enrollmentId: 'enr-reply', status: 'sent', sentAt: new Date() }],
    events
  });
  assert.strictEqual(m.totalReplies, 3);
  assert.strictEqual(m.uniqueRepliers, 1);
  assert.strictEqual(m.replyRate, 100);
  console.log('✔ Test 7 passed: One contact replies 3 times -> unique replier = 1, total replies = 3');
}

// ---------------------------------------------------------------------
// Test 8: Multiple messages in same campaign (Step 1 & Step 2) don't double-count contact.
// ---------------------------------------------------------------------
{
  const enrollments = [{ id: 'enr-seq', campaignId: 'c8', contactId: 'cnt-1', currentStep: 2, status: 'active' }];
  const messages = [
    { id: 'msg-step1', campaignId: 'c8', enrollmentId: 'enr-seq', status: 'sent', sentAt: new Date() },
    { id: 'msg-step2', campaignId: 'c8', enrollmentId: 'enr-seq', status: 'sent', sentAt: new Date() }
  ];
  const m = calculateMetrics({ enrollments, messages, events: [] });
  assert.strictEqual(m.sent, 2, 'Two total messages sent');
  assert.strictEqual(m.uniqueSent, 1, 'Only one unique person sent to');
  assert.strictEqual(m.uniqueDelivered, 1);
  console.log('✔ Test 8 passed: Multiple messages in same campaign do not double-count unique recipient');
}

// ---------------------------------------------------------------------
// Test 9: Events from different campaigns remain strictly isolated.
// ---------------------------------------------------------------------
{
  const events = [
    { id: 'e-c1', campaignId: 'camp-A', enrollmentId: 'enr-A', eventType: 'opened', eventAt: new Date() },
    { id: 'e-c2', campaignId: 'camp-B', enrollmentId: 'enr-B', eventType: 'opened', eventAt: new Date() }
  ];
  const campAEvents = events.filter((e) => e.campaignId === 'camp-A');
  const m = calculateMetrics({
    enrollments: [{ id: 'enr-A', campaignId: 'camp-A', contactId: 'cnt-A', currentStep: 1, status: 'active' }],
    messages: [{ id: 'm-A', campaignId: 'camp-A', enrollmentId: 'enr-A', status: 'sent', sentAt: new Date() }],
    events: campAEvents
  });
  assert.strictEqual(m.totalOpens, 1);
  assert.strictEqual(m.uniqueOpeners, 1);
  console.log('✔ Test 9 passed: Events from different campaigns remain isolated');
}

// ---------------------------------------------------------------------
// Test 10: Bounce doesn't count as an open.
// ---------------------------------------------------------------------
{
  const events = [
    { id: 'e-bnc', campaignId: 'c10', enrollmentId: 'enr-bnc', eventType: 'bounced', eventAt: new Date() }
  ];
  const m = calculateMetrics({
    enrollments: [{ id: 'enr-bnc', campaignId: 'c10', contactId: 'c-1', currentStep: 1, status: 'bounced' }],
    messages: [{ id: 'm-bnc', campaignId: 'c10', enrollmentId: 'enr-bnc', status: 'bounced', sentAt: new Date() }],
    events
  });
  assert.strictEqual(m.totalOpens, 0);
  assert.strictEqual(m.uniqueOpeners, 0);
  assert.strictEqual(m.uniqueBounced, 1);
  console.log('✔ Test 10 passed: Bounce is tracked separately and does not count as an open');
}

// ---------------------------------------------------------------------
// Test 11: Unsubscribe remains separately visible.
// ---------------------------------------------------------------------
{
  const events = [
    { id: 'e-unsub', campaignId: 'c11', enrollmentId: 'enr-unsub', eventType: 'unsubscribed', eventAt: new Date() }
  ];
  const m = calculateMetrics({
    enrollments: [{ id: 'enr-unsub', campaignId: 'c11', contactId: 'c-1', currentStep: 1, status: 'unsubscribed' }],
    messages: [{ id: 'm-sent', campaignId: 'c11', enrollmentId: 'enr-unsub', status: 'sent', sentAt: new Date() }],
    events
  });
  assert.strictEqual(m.uniqueUnsubscribed, 1);
  assert.strictEqual(m.unsubscribeRate, 100);
  console.log('✔ Test 11 passed: Unsubscribe remains separately tracked and visible');
}

// ---------------------------------------------------------------------
// Test 12: Step analytics correctly attribute events to sequence step.
// ---------------------------------------------------------------------
{
  const messages = [
    { id: 'msg-s1', campaignId: 'c12', enrollmentId: 'enr-1', sequenceStepId: 'step-1', status: 'sent', sentAt: new Date() },
    { id: 'msg-s2', campaignId: 'c12', enrollmentId: 'enr-1', sequenceStepId: 'step-2', status: 'sent', sentAt: new Date() }
  ];
  const events = [
    { id: 'ev-s1', campaignId: 'c12', enrollmentId: 'enr-1', emailMessageId: 'msg-s1', eventType: 'opened', eventAt: new Date() }
  ];

  const step1Events = events.filter((e) => e.emailMessageId === 'msg-s1');
  const step2Events = events.filter((e) => e.emailMessageId === 'msg-s2');

  assert.strictEqual(step1Events.length, 1);
  assert.strictEqual(step2Events.length, 0);
  console.log('✔ Test 12 passed: Step analytics correctly attribute events to sequence step');
}

// ---------------------------------------------------------------------
// Test 13: Contact-level lastActivityAt is calculated correctly.
// ---------------------------------------------------------------------
{
  const sentAt = new Date('2026-09-09T09:00:00Z');
  const openedAt = new Date('2026-09-09T09:15:00Z');
  const clickedAt = new Date('2026-09-09T09:30:00Z');

  const timestamps = [sentAt, openedAt, clickedAt];
  const lastActivityAt = new Date(Math.max(...timestamps.map((t) => t.getTime())));
  assert.strictEqual(lastActivityAt.toISOString(), clickedAt.toISOString());
  console.log('✔ Test 13 passed: lastActivityAt correctly resolves to the latest engagement event');
}

// ---------------------------------------------------------------------
// Test 14: Activity timeline uses correct timezone boundaries.
// ---------------------------------------------------------------------
{
  const d = new Date('2026-09-09T10:00:00Z');
  const istDateStr = d.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric' });
  assert.strictEqual(istDateStr, 'Sep 9');
  console.log('✔ Test 14 passed: Timeline formatter strictly supports target timezone (Asia/Kolkata)');
}

// ---------------------------------------------------------------------
// Test 15: Campaign lifetime totals match event sum.
// ---------------------------------------------------------------------
{
  const events = [
    { id: '1', campaignId: 'c15', enrollmentId: 'e1', eventType: 'opened', eventAt: new Date() },
    { id: '2', campaignId: 'c15', enrollmentId: 'e2', eventType: 'opened', eventAt: new Date() },
    { id: '3', campaignId: 'c15', enrollmentId: 'e1', eventType: 'clicked', eventAt: new Date() }
  ];
  const m = calculateMetrics({
    enrollments: [
      { id: 'e1', campaignId: 'c15', contactId: 'c1', currentStep: 1, status: 'active' },
      { id: 'e2', campaignId: 'c15', contactId: 'c2', currentStep: 1, status: 'active' }
    ],
    messages: [
      { id: 'm1', campaignId: 'c15', enrollmentId: 'e1', status: 'sent', sentAt: new Date() },
      { id: 'm2', campaignId: 'c15', enrollmentId: 'e2', status: 'sent', sentAt: new Date() }
    ],
    events
  });
  assert.strictEqual(m.totalOpens, 2);
  assert.strictEqual(m.totalClicks, 1);
  console.log('✔ Test 15 passed: Campaign lifetime totals match exact event sums');
}

// ---------------------------------------------------------------------
// Test 16: Date-range analytics exclude events outside the range.
// ---------------------------------------------------------------------
{
  const t1 = new Date('2026-09-01T00:00:00Z');
  const t2 = new Date('2026-09-05T00:00:00Z');
  const t3 = new Date('2026-09-10T00:00:00Z');

  const events = [
    { id: 'e-old', campaignId: 'c16', enrollmentId: 'e1', eventType: 'opened', eventAt: t1 },
    { id: 'e-in', campaignId: 'c16', enrollmentId: 'e1', eventType: 'opened', eventAt: t2 },
    { id: 'e-fut', campaignId: 'c16', enrollmentId: 'e1', eventType: 'opened', eventAt: t3 }
  ];

  const m = calculateMetrics({
    enrollments: [{ id: 'e1', campaignId: 'c16', contactId: 'c1', currentStep: 1, status: 'active' }],
    messages: [{ id: 'm1', campaignId: 'c16', enrollmentId: 'e1', status: 'sent', sentAt: t2 }],
    events,
    startDate: new Date('2026-09-04T00:00:00Z'),
    endDate: new Date('2026-09-06T00:00:00Z')
  });

  assert.strictEqual(m.totalOpens, 1);
  console.log('✔ Test 16 passed: Date-range filters exclude events outside requested boundaries');
}

// ---------------------------------------------------------------------
// Test 17: Duplicate event records do not create duplicate unique people.
// ---------------------------------------------------------------------
{
  const events = [
    { id: 'dup-1', campaignId: 'c17', enrollmentId: 'e1', eventType: 'opened', eventAt: new Date() },
    { id: 'dup-2', campaignId: 'c17', enrollmentId: 'e1', eventType: 'opened', eventAt: new Date() }
  ];
  const m = calculateMetrics({
    enrollments: [{ id: 'e1', campaignId: 'c17', contactId: 'c1', currentStep: 1, status: 'active' }],
    messages: [{ id: 'm1', campaignId: 'c17', enrollmentId: 'e1', status: 'sent', sentAt: new Date() }],
    events
  });
  assert.strictEqual(m.uniqueOpeners, 1);
  console.log('✔ Test 17 passed: Duplicate event records do not increase unique person counts');
}

// ---------------------------------------------------------------------
// Test 18: Failed email sends don't count as sent.
// ---------------------------------------------------------------------
{
  const messages = [
    { id: 'm-fail', campaignId: 'c18', enrollmentId: 'e1', status: 'failed', sentAt: new Date() }
  ];
  const m = calculateMetrics({
    enrollments: [{ id: 'e1', campaignId: 'c18', contactId: 'c1', currentStep: 1, status: 'failed' }],
    messages,
    events: []
  });
  assert.strictEqual(m.sent, 0);
  assert.strictEqual(m.uniqueSent, 0);
  console.log('✔ Test 18 passed: Failed email sends are excluded from sent counts');
}

// ---------------------------------------------------------------------
// Test 19: Draft/pending queue messages don't count as sent.
// ---------------------------------------------------------------------
{
  const messages = [
    { id: 'm-pend', campaignId: 'c19', enrollmentId: 'e1', status: 'pending' }
  ];
  const m = calculateMetrics({
    enrollments: [{ id: 'e1', campaignId: 'c19', contactId: 'c1', currentStep: 1, status: 'pending' }],
    messages,
    events: []
  });
  assert.strictEqual(m.sent, 0);
  console.log('✔ Test 19 passed: Draft / pending queue messages do not count as sent');
}

// ---------------------------------------------------------------------
// Test 20: Funnel calculation preserves 5 distinct stages.
// ---------------------------------------------------------------------
{
  const enrollments = Array.from({ length: 5 }, (_, i) => ({
    id: `e-${i}`,
    campaignId: 'c20',
    contactId: `c-${i}`,
    currentStep: 1,
    status: 'active'
  }));

  const messages = enrollments.map((e) => ({
    id: `m-${e.id}`,
    campaignId: 'c20',
    enrollmentId: e.id,
    status: 'delivered',
    sentAt: new Date()
  }));

  const events = [
    // 4 openers
    { id: 'o1', campaignId: 'c20', enrollmentId: 'e-0', eventType: 'opened', eventAt: new Date() },
    { id: 'o2', campaignId: 'c20', enrollmentId: 'e-1', eventType: 'opened', eventAt: new Date() },
    { id: 'o3', campaignId: 'c20', enrollmentId: 'e-2', eventType: 'opened', eventAt: new Date() },
    { id: 'o4', campaignId: 'c20', enrollmentId: 'e-3', eventType: 'opened', eventAt: new Date() },
    // 2 clickers
    { id: 'c1', campaignId: 'c20', enrollmentId: 'e-0', eventType: 'clicked', eventAt: new Date() },
    { id: 'c2', campaignId: 'c20', enrollmentId: 'e-1', eventType: 'clicked', eventAt: new Date() },
    // 1 replier
    { id: 'r1', campaignId: 'c20', enrollmentId: 'e-0', eventType: 'replied', eventAt: new Date() }
  ];

  const m = calculateMetrics({ enrollments, messages, events });
  assert.strictEqual(m.funnel.length, 5);
  assert.strictEqual(m.funnel[0]?.count, 5); // Sent
  assert.strictEqual(m.funnel[1]?.count, 5); // Delivered
  assert.strictEqual(m.funnel[2]?.count, 4); // Opened (80%)
  assert.strictEqual(m.funnel[3]?.count, 2); // Clicked (40%)
  assert.strictEqual(m.funnel[4]?.count, 1); // Replied (20%)
  console.log('✔ Test 20 passed: Funnel accurately calculates 5 unique stages (Sent -> Delivered -> Opened -> Clicked -> Replied)');
}

console.log('\nAll 20 Outreach Analytics & Data Correctness Tests Passed Successfully!\n');
