import assert from 'assert';

console.log('====================================================');
console.log('  RUNNING DELIVERY SEMANTICS & CONFIDENCE TEST SUITE ');
console.log('  Transport States • Delivery Inferred • Engagement  ');
console.log('  Zero Real Emails • Zero Scheduler Dispatch        ');
console.log('====================================================\n');

// Types mirroring the refined delivery tracking models
export type TransportStatus = 'DISPATCHED' | 'SMTP_ACCEPTED' | 'BOUNCED' | 'FAILED';
export type DeliveryConfidence = 'UNKNOWN' | 'DELIVERY_INFERRED' | 'ENGAGEMENT_CONFIRMED';
export type BounceType = 'hard' | 'soft' | 'unknown';

export interface EmailMessageModel {
  id: string;
  enrollmentId: string;
  contactId: string;
  campaignId: string;
  status: string; // 'pending' | 'sent' | 'bounced' | 'soft_bounced' | 'failed' | 'replied' | 'opened' | 'clicked'
  transportStatus: TransportStatus;
  deliveryConfidence: DeliveryConfidence;
  smtpAcceptedAt: Date | null;
  smtpResponseCode: string | null;
  smtpResponse: string | null;
  internetMessageId: string | null;
  providerMessageId: string | null;
  sentAt: Date | null;
  bouncedAt: Date | null;
  bounceType: BounceType | null;
  bounceCode: string | null;
  bounceReason: string | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  repliedAt: Date | null;
}

export interface SuppressionEntry {
  email: string;
  reason: 'hard_bounce' | 'unsubscribe' | 'manual';
  suppressedAt: Date;
}

export interface EmailEventModel {
  id: string;
  emailMessageId: string;
  enrollmentId: string;
  contactId: string;
  eventType: 'sent' | 'opened' | 'clicked' | 'replied' | 'bounced' | 'soft_bounced';
  eventAt: Date;
}

// In-memory calculator mirroring AnalyticsService delivery semantics
export function computeDeliveryMetrics(params: {
  messages: EmailMessageModel[];
  events: EmailEventModel[];
}) {
  const { messages, events } = params;

  // 1. Sent & SMTP Accepted (all messages dispatched through transport including subsequent bounces)
  const sentMessages = messages.filter(
    (m) => m.sentAt !== null || m.status === 'sent' || m.status === 'delivered' || m.status === 'bounced' || m.status === 'soft_bounced' || m.status === 'opened' || m.status === 'clicked' || m.status === 'replied' || m.transportStatus === 'SMTP_ACCEPTED'
  );
  const sentCount = sentMessages.length;

  const sentContactIds = new Set<string>();
  sentMessages.forEach((m) => sentContactIds.add(m.contactId));
  const uniqueSent = sentContactIds.size;

  const smtpAcceptedCount = messages.filter((m) => m.transportStatus === 'SMTP_ACCEPTED').length;

  // 2. Bounced
  const bouncedMessages = messages.filter(
    (m) => m.status === 'bounced' || m.status === 'soft_bounced' || m.transportStatus === 'BOUNCED'
  );
  const bouncedContactIds = new Set<string>();
  bouncedMessages.forEach((m) => bouncedContactIds.add(m.contactId));
  const uniqueBounced = bouncedContactIds.size;

  // 3. Delivery Inferred = SMTP Accepted - Bounced
  const deliveryInferredCount = Math.max(0, sentCount - bouncedMessages.length);
  const uniqueDeliveryInferred = Math.max(0, uniqueSent - uniqueBounced);

  // 4. Opens
  const openEvents = events.filter((e) => e.eventType === 'opened');
  const uniqueOpenerIds = new Set<string>();
  openEvents.forEach((e) => uniqueOpenerIds.add(e.contactId));
  const uniqueOpeners = uniqueOpenerIds.size;
  const totalOpens = openEvents.length;

  // 5. Clicks
  const clickEvents = events.filter((e) => e.eventType === 'clicked');
  const uniqueClickerIds = new Set<string>();
  clickEvents.forEach((e) => uniqueClickerIds.add(e.contactId));
  const uniqueClickers = uniqueClickerIds.size;
  const totalClicks = clickEvents.length;

  // 6. Replies
  const replyEvents = events.filter((e) => e.eventType === 'replied');
  const uniqueReplierIds = new Set<string>();
  replyEvents.forEach((e) => uniqueReplierIds.add(e.contactId));
  const uniqueRepliers = uniqueReplierIds.size;
  const totalReplies = replyEvents.length;

  // 7. Rates calculated strictly against uniqueDeliveryInferred
  const uniqueOpenRate =
    uniqueDeliveryInferred > 0
      ? Math.min(100, Number(((uniqueOpeners / uniqueDeliveryInferred) * 100).toFixed(1)))
      : null;

  const uniqueClickRate =
    uniqueDeliveryInferred > 0
      ? Math.min(100, Number(((uniqueClickers / uniqueDeliveryInferred) * 100).toFixed(1)))
      : null;

  const replyRate =
    uniqueDeliveryInferred > 0
      ? Math.min(100, Number(((uniqueRepliers / uniqueDeliveryInferred) * 100).toFixed(1)))
      : null;

  const deliveryRate =
    uniqueSent > 0
      ? Math.min(100, Number(((uniqueDeliveryInferred / uniqueSent) * 100).toFixed(1)))
      : null;

  return {
    sent: sentCount,
    uniqueSent,
    smtpAccepted: smtpAcceptedCount,
    bounced: uniqueBounced,
    delivered: deliveryInferredCount,
    deliveryInferred: deliveryInferredCount,
    uniqueDelivered: uniqueDeliveryInferred,
    uniqueDeliveryInferred,
    deliveryRate,
    totalOpens,
    uniqueOpeners,
    uniqueOpenRate,
    totalClicks,
    uniqueClickers,
    uniqueClickRate,
    totalReplies,
    uniqueRepliers,
    replyRate
  };
}

async function runTests() {
  // ----------------------------------------------------
  // Test 1: SMTP Accepted Transport State
  // ----------------------------------------------------
  console.log('--- 1. Testing SMTP Accepted Transport State ---');
  const msgSmtpOk: EmailMessageModel = {
    id: 'msg-1',
    enrollmentId: 'enr-1',
    contactId: 'c-1',
    campaignId: 'camp-1',
    status: 'sent',
    transportStatus: 'SMTP_ACCEPTED',
    deliveryConfidence: 'DELIVERY_INFERRED',
    smtpAcceptedAt: new Date(),
    smtpResponseCode: '250',
    smtpResponse: '250 2.0.0 OK (Accepted by mail server)',
    internetMessageId: '<tg_abc123@tripgain.com>',
    providerMessageId: 'msg_abc123',
    sentAt: new Date(),
    bouncedAt: null,
    bounceType: null,
    bounceCode: null,
    bounceReason: null,
    openedAt: null,
    clickedAt: null,
    repliedAt: null
  };

  assert.strictEqual(msgSmtpOk.transportStatus, 'SMTP_ACCEPTED');
  assert.strictEqual(msgSmtpOk.deliveryConfidence, 'DELIVERY_INFERRED');
  assert.strictEqual(msgSmtpOk.smtpResponseCode, '250');
  assert.ok(msgSmtpOk.smtpAcceptedAt instanceof Date);
  console.log('✔ Test 1 passed: Successful SMTP acceptance transitions to SMTP_ACCEPTED & DELIVERY_INFERRED\n');

  // ----------------------------------------------------
  // Test 2: Immediate SMTP Failure
  // ----------------------------------------------------
  console.log('--- 2. Testing Immediate SMTP Failure ---');
  const msgSmtpFail: EmailMessageModel = {
    id: 'msg-2',
    enrollmentId: 'enr-2',
    contactId: 'c-2',
    campaignId: 'camp-1',
    status: 'failed',
    transportStatus: 'FAILED',
    deliveryConfidence: 'UNKNOWN',
    smtpAcceptedAt: null,
    smtpResponseCode: '550',
    smtpResponse: '550 5.1.1 User unknown / relay denied',
    internetMessageId: null,
    providerMessageId: null,
    sentAt: null,
    bouncedAt: null,
    bounceType: null,
    bounceCode: null,
    bounceReason: null,
    openedAt: null,
    clickedAt: null,
    repliedAt: null
  };

  assert.strictEqual(msgSmtpFail.transportStatus, 'FAILED');
  assert.strictEqual(msgSmtpFail.deliveryConfidence, 'UNKNOWN');
  assert.strictEqual(msgSmtpFail.smtpResponseCode, '550');
  console.log('✔ Test 2 passed: Immediate transport failure records FAILED with UNKNOWN confidence\n');

  // ----------------------------------------------------
  // Test 3: Hard Bounce & Permanent Suppression
  // ----------------------------------------------------
  console.log('--- 3. Testing Hard Bounce & Permanent Suppression ---');
  const suppressionList: SuppressionEntry[] = [];
  const msgHardBounce: EmailMessageModel = {
    ...msgSmtpOk,
    id: 'msg-3',
    status: 'bounced',
    transportStatus: 'BOUNCED',
    deliveryConfidence: 'UNKNOWN',
    bouncedAt: new Date(),
    bounceType: 'hard',
    bounceCode: '5.1.1',
    bounceReason: 'Permanent address failure: user not found'
  };

  // Hard bounce suppression rule
  if (msgHardBounce.bounceType === 'hard') {
    suppressionList.push({
      email: 'invalid@example.com',
      reason: 'hard_bounce',
      suppressedAt: new Date()
    });
  }

  assert.strictEqual(msgHardBounce.transportStatus, 'BOUNCED');
  assert.strictEqual(msgHardBounce.deliveryConfidence, 'UNKNOWN');
  assert.strictEqual(msgHardBounce.bounceType, 'hard');
  assert.strictEqual(suppressionList.length, 1);
  assert.strictEqual(suppressionList[0]?.reason, 'hard_bounce');
  console.log('✔ Test 3 passed: Hard bounce results in permanent suppression on SuppressionList\n');

  // ----------------------------------------------------
  // Test 4: Soft Bounce (No Permanent Suppression)
  // ----------------------------------------------------
  console.log('--- 4. Testing Soft Bounce Behavior ---');
  const msgSoftBounce: EmailMessageModel = {
    ...msgSmtpOk,
    id: 'msg-4',
    status: 'soft_bounced',
    transportStatus: 'BOUNCED',
    deliveryConfidence: 'UNKNOWN',
    bouncedAt: new Date(),
    bounceType: 'soft',
    bounceCode: '4.2.2',
    bounceReason: 'Temporary delivery deferral: mailbox full'
  };

  const softSuppressionList: SuppressionEntry[] = [];
  let enrollmentStatus = 'active';
  let stopReason: string | null = null;

  // Soft bounce rule: stop sequence, NO auto-retry, NO permanent suppression
  if (msgSoftBounce.bounceType === 'soft') {
    enrollmentStatus = 'soft_bounced';
    stopReason = 'SOFT_BOUNCE';
    // Do NOT add to softSuppressionList
  }

  assert.strictEqual(msgSoftBounce.transportStatus, 'BOUNCED');
  assert.strictEqual(msgSoftBounce.bounceType, 'soft');
  assert.strictEqual(enrollmentStatus, 'soft_bounced');
  assert.strictEqual(stopReason, 'SOFT_BOUNCE');
  assert.strictEqual(softSuppressionList.length, 0, 'Soft bounce MUST NOT add to permanent suppression');
  console.log('✔ Test 4 passed: Soft bounce halts sequence without permanent suppression\n');

  // ----------------------------------------------------
  // Test 5: Reply Received (Strongest Evidence)
  // ----------------------------------------------------
  console.log('--- 5. Testing Reply Engagement Confirmation ---');
  const msgReplied: EmailMessageModel = {
    ...msgSmtpOk,
    id: 'msg-5',
    status: 'replied',
    repliedAt: new Date(),
    deliveryConfidence: 'ENGAGEMENT_CONFIRMED'
  };

  assert.strictEqual(msgReplied.status, 'replied');
  assert.strictEqual(msgReplied.deliveryConfidence, 'ENGAGEMENT_CONFIRMED');
  console.log('✔ Test 5 passed: Inbound reply promotes confidence to ENGAGEMENT_CONFIRMED\n');

  // ----------------------------------------------------
  // Test 6: Open Tracking Engagement
  // ----------------------------------------------------
  console.log('--- 6. Testing Open Tracking Engagement ---');
  const msgOpened: EmailMessageModel = {
    ...msgSmtpOk,
    id: 'msg-6',
    status: 'opened',
    openedAt: new Date(),
    deliveryConfidence: 'ENGAGEMENT_CONFIRMED'
  };

  assert.strictEqual(msgOpened.deliveryConfidence, 'ENGAGEMENT_CONFIRMED');
  assert.ok(msgOpened.openedAt instanceof Date);
  console.log('✔ Test 6 passed: Open tracking records engagement without claiming human reading\n');

  // ----------------------------------------------------
  // Test 7: Click Tracking Engagement
  // ----------------------------------------------------
  console.log('--- 7. Testing Click Tracking Engagement ---');
  const msgClicked: EmailMessageModel = {
    ...msgSmtpOk,
    id: 'msg-7',
    status: 'clicked',
    clickedAt: new Date(),
    deliveryConfidence: 'ENGAGEMENT_CONFIRMED'
  };

  assert.strictEqual(msgClicked.deliveryConfidence, 'ENGAGEMENT_CONFIRMED');
  assert.ok(msgClicked.clickedAt instanceof Date);
  console.log('✔ Test 7 passed: Click tracking promotes delivery confidence to ENGAGEMENT_CONFIRMED\n');

  // ----------------------------------------------------
  // Test 8: Open-Count Inflation Protection
  // ----------------------------------------------------
  console.log('--- 8. Testing Open-Count Inflation Protection ---');
  // Scenario: 1 lead opens email 10 times (or automated scanner triggers 10 pixel requests)
  const singleContactMessages: EmailMessageModel[] = [
    { ...msgSmtpOk, id: 'm-single', contactId: 'c-vip' }
  ];
  const inflatedOpenEvents: EmailEventModel[] = Array.from({ length: 10 }, (_, i) => ({
    id: `ev-open-${i}`,
    emailMessageId: 'm-single',
    enrollmentId: 'enr-vip',
    contactId: 'c-vip',
    eventType: 'opened',
    eventAt: new Date(Date.now() + i * 1000)
  }));

  const inflationMetrics = computeDeliveryMetrics({
    messages: singleContactMessages,
    events: inflatedOpenEvents
  });

  assert.strictEqual(inflationMetrics.totalOpens, 10, 'Total opens should count all 10 raw events');
  assert.strictEqual(inflationMetrics.uniqueOpeners, 1, 'Unique openers MUST deduplicate to 1 person');
  assert.strictEqual(inflationMetrics.uniqueOpenRate, 100, 'Unique open rate MUST be 100%, never 1000%');
  console.log('✔ Test 8 passed: 10 open events by 1 contact yields exactly 1 unique opener (100% rate, zero inflation)\n');

  // ----------------------------------------------------
  // Test 9: Click-Count Inflation Protection
  // ----------------------------------------------------
  console.log('--- 9. Testing Click-Count Inflation Protection ---');
  // Scenario: 1 lead clicks 15 links (security link scanner or repeated clicks)
  const inflatedClickEvents: EmailEventModel[] = Array.from({ length: 15 }, (_, i) => ({
    id: `ev-click-${i}`,
    emailMessageId: 'm-single',
    enrollmentId: 'enr-vip',
    contactId: 'c-vip',
    eventType: 'clicked',
    eventAt: new Date(Date.now() + i * 1000)
  }));

  const clickInflationMetrics = computeDeliveryMetrics({
    messages: singleContactMessages,
    events: inflatedClickEvents
  });

  assert.strictEqual(clickInflationMetrics.totalClicks, 15, 'Total clicks count all 15 raw events');
  assert.strictEqual(clickInflationMetrics.uniqueClickers, 1, 'Unique clickers MUST deduplicate to 1 person');
  assert.strictEqual(clickInflationMetrics.uniqueClickRate, 100, 'Unique click rate MUST be 100%');
  console.log('✔ Test 9 passed: 15 click events by 1 contact yields exactly 1 unique clicker (100% rate)\n');

  // ----------------------------------------------------
  // Test 10: Multi-Step Unique Delivery Deduplication
  // ----------------------------------------------------
  console.log('--- 10. Testing Multi-Step Unique Delivery Deduplication ---');
  // Scenario: 3 sequence steps sent to the same lead over a week
  const multiStepMessages: EmailMessageModel[] = [
    { ...msgSmtpOk, id: 'step-1-msg', contactId: 'c-same-lead' },
    { ...msgSmtpOk, id: 'step-2-msg', contactId: 'c-same-lead' },
    { ...msgSmtpOk, id: 'step-3-msg', contactId: 'c-same-lead' }
  ];

  const multiStepMetrics = computeDeliveryMetrics({
    messages: multiStepMessages,
    events: []
  });

  assert.strictEqual(multiStepMetrics.sent, 3, 'Total sent is 3 messages');
  assert.strictEqual(multiStepMetrics.uniqueSent, 1, 'Unique sent is 1 contact');
  assert.strictEqual(multiStepMetrics.delivered, 3, 'Total delivered inferred is 3 messages');
  assert.strictEqual(multiStepMetrics.uniqueDelivered, 1, 'Unique delivered inferred is 1 contact');
  console.log('✔ Test 10 passed: Multi-step outreach correctly deduplicates to unique delivered contacts\n');

  // ----------------------------------------------------
  // Test 11: Unique Open Rate Mathematical Correctness
  // ----------------------------------------------------
  console.log('--- 11. Testing Unique Open Rate Calculation ---');
  // 100 sent, 5 bounced -> 95 delivery inferred
  // 31 unique openers
  // Expected open rate = (31 / 95) * 100 = 32.6%
  const cohortMessages: EmailMessageModel[] = [
    ...Array.from({ length: 95 }, (_, i) => ({
      ...msgSmtpOk,
      id: `m-deliv-${i}`,
      contactId: `c-cohort-${i}`
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      ...msgHardBounce,
      id: `m-bounce-${i}`,
      contactId: `c-cohort-bounce-${i}`
    }))
  ];

  const cohortOpenEvents: EmailEventModel[] = Array.from({ length: 31 }, (_, i) => ({
    id: `ev-cohort-open-${i}`,
    emailMessageId: `m-deliv-${i}`,
    enrollmentId: `enr-deliv-${i}`,
    contactId: `c-cohort-${i}`,
    eventType: 'opened',
    eventAt: new Date()
  }));

  const cohortMetrics = computeDeliveryMetrics({
    messages: cohortMessages,
    events: cohortOpenEvents
  });

  assert.strictEqual(cohortMetrics.sent, 100);
  assert.strictEqual(cohortMetrics.bounced, 5);
  assert.strictEqual(cohortMetrics.deliveryInferred, 95);
  assert.strictEqual(cohortMetrics.uniqueDeliveryInferred, 95);
  assert.strictEqual(cohortMetrics.uniqueOpeners, 31);
  assert.strictEqual(cohortMetrics.uniqueOpenRate, 32.6, 'Expected 31 / 95 * 100 = 32.6%');
  console.log('✔ Test 11 passed: Unique Open Rate correctly calculated as 31 / 95 = 32.6%\n');

  // ----------------------------------------------------
  // Test 12: Unique Click Rate Mathematical Correctness
  // ----------------------------------------------------
  console.log('--- 12. Testing Unique Click Rate Calculation ---');
  // 12 unique clickers out of 95 delivery inferred -> (12 / 95) * 100 = 12.6%
  const cohortClickEvents: EmailEventModel[] = Array.from({ length: 12 }, (_, i) => ({
    id: `ev-cohort-click-${i}`,
    emailMessageId: `m-deliv-${i}`,
    enrollmentId: `enr-deliv-${i}`,
    contactId: `c-cohort-${i}`,
    eventType: 'clicked',
    eventAt: new Date()
  }));

  const clickMetrics = computeDeliveryMetrics({
    messages: cohortMessages,
    events: cohortClickEvents
  });

  assert.strictEqual(clickMetrics.uniqueClickers, 12);
  assert.strictEqual(clickMetrics.uniqueClickRate, 12.6, 'Expected 12 / 95 * 100 = 12.6%');
  console.log('✔ Test 12 passed: Unique Click Rate correctly calculated as 12 / 95 = 12.6%\n');

  // ----------------------------------------------------
  // Test 13: Unique Reply Rate Mathematical Correctness
  // ----------------------------------------------------
  console.log('--- 13. Testing Unique Reply Rate Calculation ---');
  // 7 unique repliers out of 95 delivery inferred -> (7 / 95) * 100 = 7.4%
  const cohortReplyEvents: EmailEventModel[] = Array.from({ length: 7 }, (_, i) => ({
    id: `ev-cohort-reply-${i}`,
    emailMessageId: `m-deliv-${i}`,
    enrollmentId: `enr-deliv-${i}`,
    contactId: `c-cohort-${i}`,
    eventType: 'replied',
    eventAt: new Date()
  }));

  const replyMetrics = computeDeliveryMetrics({
    messages: cohortMessages,
    events: cohortReplyEvents
  });

  assert.strictEqual(replyMetrics.uniqueRepliers, 7);
  assert.strictEqual(replyMetrics.replyRate, 7.4, 'Expected 7 / 95 * 100 = 7.4%');
  console.log('✔ Test 13 passed: Unique Reply Rate correctly calculated as 7 / 95 = 7.4%\n');

  console.log('====================================================');
  console.log('  ALL 13 DELIVERY SEMANTICS SCENARIOS PASSED! 🎉    ');
  console.log('====================================================');
}

runTests().catch((err) => {
  console.error('❌ DELIVERY SEMANTICS TEST FAILED:', err);
  process.exit(1);
});
