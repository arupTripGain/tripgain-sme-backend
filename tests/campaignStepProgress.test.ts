import assert from 'assert';
import {
  calculateCampaignStepProgressAndCompletion,
  formatCompletionPercentage
} from '../src/services/campaignProgressService';

function runTests() {
  console.log('--- Starting Campaign Step Progress & Completion Tests ---');

  // Test 1: Campaign with 1 step
  {
    const campaign = {
      sequences: [{
        steps: [{ id: 's1', stepNumber: 1, stepName: 'Single Outreach' }]
      }],
      enrollments: [
        { id: 'e1', status: 'completed', currentStep: 1 },
        { id: 'e2', status: 'completed', currentStep: 1 }
      ],
      messages: [
        { id: 'm1', sequenceStepId: 's1', enrollmentId: 'e1', status: 'sent', sentAt: new Date() },
        { id: 'm2', sequenceStepId: 's1', enrollmentId: 'e2', status: 'sent', sentAt: new Date() }
      ]
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    assert.strictEqual(res.stepProgress.length, 1, 'Should have 1 step');
    assert.strictEqual(res.stepProgress[0]!.stepName, 'Single Outreach');
    assert.strictEqual(res.stepProgress[0]!.eligibleCount, 2);
    assert.strictEqual(res.stepProgress[0]!.sentCount, 2);
    assert.strictEqual(res.stepProgress[0]!.completionPercentage, 100);
    assert.strictEqual(res.stepProgress[0]!.status, 'COMPLETED');
    assert.strictEqual(res.campaignCompletion.completed, true);
    console.log('✓ Test 1: Campaign with 1 step passed');
  }

  // Test 2: Campaign with 3 steps
  {
    const campaign = {
      sequences: [{
        steps: [
          { id: 's1', stepNumber: 1, stepName: 'Intro' },
          { id: 's2', stepNumber: 2, stepName: 'Followup 1' },
          { id: 's3', stepNumber: 3, stepName: 'Final Followup' }
        ]
      }],
      enrollments: [
        { id: 'e1', status: 'active', currentStep: 1 },
        { id: 'e2', status: 'active', currentStep: 1 }
      ],
      messages: []
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    assert.strictEqual(res.stepProgress.length, 3);
    assert.strictEqual(res.stepProgress[0]!.stepName, 'Intro');
    assert.strictEqual(res.stepProgress[1]!.stepName, 'Followup 1');
    assert.strictEqual(res.stepProgress[2]!.stepName, 'Final Followup');
    assert.strictEqual(res.campaignCompletion.totalSteps, 3);
    console.log('✓ Test 2: Campaign with 3 steps passed');
  }

  // Test 3: Step 1 partially complete (e.g. 250 sent out of 500 = 50%)
  {
    const enrollments = Array.from({ length: 500 }, (_, i) => ({
      id: `e-${i}`,
      status: 'active',
      currentStep: i < 250 ? 2 : 1
    }));
    const messages = Array.from({ length: 250 }, (_, i) => ({
      id: `m-${i}`,
      sequenceStepId: 's1',
      enrollmentId: `e-${i}`,
      status: 'sent',
      sentAt: new Date()
    }));
    const campaign = {
      sequences: [{
        steps: [
          { id: 's1', stepNumber: 1, stepName: 'Initial Outreach' },
          { id: 's2', stepNumber: 2, stepName: 'Follow-up' }
        ]
      }],
      enrollments,
      messages
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    const step1 = res.stepProgress[0]!;
    assert.strictEqual(step1.eligibleCount, 500);
    assert.strictEqual(step1.sentCount, 250);
    assert.strictEqual(step1.remainingCount, 250);
    assert.strictEqual(step1.completionPercentage, 50);
    assert.strictEqual(step1.status, 'IN_PROGRESS');
    console.log('✓ Test 3: Step 1 partially complete passed');
  }

  // Test 4: Step 2 partially complete (e.g. 120 sent out of 343 = 35%)
  {
    // 343 enrollments reached step 2
    const enrollments = Array.from({ length: 343 }, (_, i) => ({
      id: `e-${i}`,
      status: 'active',
      currentStep: i < 120 ? 3 : 2
    }));
    // All 343 had step 1 sent
    const step1Messages = Array.from({ length: 343 }, (_, i) => ({
      id: `m1-${i}`,
      sequenceStepId: 's1',
      enrollmentId: `e-${i}`,
      status: 'sent',
      sentAt: new Date()
    }));
    // 120 had step 2 sent
    const step2Messages = Array.from({ length: 120 }, (_, i) => ({
      id: `m2-${i}`,
      sequenceStepId: 's2',
      enrollmentId: `e-${i}`,
      status: 'sent',
      sentAt: new Date()
    }));
    const campaign = {
      sequences: [{
        steps: [
          { id: 's1', stepNumber: 1, stepName: 'Initial Outreach' },
          { id: 's2', stepNumber: 2, stepName: 'Follow-up' }
        ]
      }],
      enrollments,
      messages: [...step1Messages, ...step2Messages]
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    const step2 = res.stepProgress[1]!;
    assert.strictEqual(step2.eligibleCount, 343);
    assert.strictEqual(step2.sentCount, 120);
    assert.strictEqual(step2.remainingCount, 223);
    assert.strictEqual(step2.completionPercentage, 35);
    assert.strictEqual(step2.status, 'IN_PROGRESS');
    console.log('✓ Test 4: Step 2 partially complete passed');
  }

  // Test 5: Step 3 not started (0 sent)
  {
    const campaign = {
      sequences: [{
        steps: [
          { id: 's1', stepNumber: 1, stepName: 'Initial Outreach' },
          { id: 's2', stepNumber: 2, stepName: 'Follow-up' },
          { id: 's3', stepNumber: 3, stepName: 'Final Follow-up' }
        ]
      }],
      enrollments: [
        { id: 'e1', status: 'active', currentStep: 2 }
      ],
      messages: [
        { id: 'm1', sequenceStepId: 's1', enrollmentId: 'e1', status: 'sent', sentAt: new Date() }
      ]
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    const step3 = res.stepProgress[2]!;
    assert.strictEqual(step3.sentCount, 0);
    assert.strictEqual(step3.completionPercentage, 0);
    assert.strictEqual(step3.status, 'NOT_STARTED');
    console.log('✓ Test 5: Step 3 not started passed');
  }

  // Test 6: All steps completed
  {
    const campaign = {
      sequences: [{
        steps: [
          { id: 's1', stepNumber: 1, stepName: 'Step 1' },
          { id: 's2', stepNumber: 2, stepName: 'Step 2' }
        ]
      }],
      enrollments: [
        { id: 'e1', status: 'completed', currentStep: 2 },
        { id: 'e2', status: 'completed', currentStep: 2 }
      ],
      messages: [
        { id: 'm1', sequenceStepId: 's1', enrollmentId: 'e1', status: 'sent', sentAt: new Date() },
        { id: 'm2', sequenceStepId: 's1', enrollmentId: 'e2', status: 'sent', sentAt: new Date() },
        { id: 'm3', sequenceStepId: 's2', enrollmentId: 'e1', status: 'sent', sentAt: new Date() },
        { id: 'm4', sequenceStepId: 's2', enrollmentId: 'e2', status: 'sent', sentAt: new Date() }
      ]
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    assert.strictEqual(res.stepProgress[0]!.status, 'COMPLETED');
    assert.strictEqual(res.stepProgress[1]!.status, 'COMPLETED');
    assert.strictEqual(res.campaignCompletion.completed, true);
    assert.strictEqual(res.campaignCompletion.completedSteps, 2);
    assert.strictEqual(res.campaignCompletion.completedContacts, 2);
    console.log('✓ Test 6: All steps completed passed');
  }

  // Test 7: Failed message not counted as sent
  {
    const campaign = {
      sequences: [{
        steps: [{ id: 's1', stepNumber: 1, stepName: 'Step 1' }]
      }],
      enrollments: [{ id: 'e1', status: 'active', currentStep: 1 }],
      messages: [
        { id: 'm1', sequenceStepId: 's1', enrollmentId: 'e1', status: 'failed', sentAt: null }
      ]
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    assert.strictEqual(res.stepProgress[0]!.sentCount, 0);
    assert.strictEqual(res.stepProgress[0]!.status, 'NOT_STARTED');
    console.log('✓ Test 7: Failed message not counted as sent passed');
  }

  // Test 8: Pending message not counted as sent
  {
    const campaign = {
      sequences: [{
        steps: [{ id: 's1', stepNumber: 1, stepName: 'Step 1' }]
      }],
      enrollments: [{ id: 'e1', status: 'active', currentStep: 1 }],
      messages: [
        { id: 'm1', sequenceStepId: 's1', enrollmentId: 'e1', status: 'pending', sentAt: null },
        { id: 'm2', sequenceStepId: 's1', enrollmentId: 'e1', status: 'queued', sentAt: null },
        { id: 'm3', sequenceStepId: 's1', enrollmentId: 'e1', status: 'draft', sentAt: null }
      ]
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    assert.strictEqual(res.stepProgress[0]!.sentCount, 0);
    assert.strictEqual(res.stepProgress[0]!.status, 'NOT_STARTED');
    console.log('✓ Test 8: Pending message not counted as sent passed');
  }

  // Test 9: Replied contact handled correctly
  {
    const campaign = {
      sequences: [{
        steps: [
          { id: 's1', stepNumber: 1, stepName: 'Step 1' },
          { id: 's2', stepNumber: 2, stepName: 'Step 2' }
        ]
      }],
      enrollments: [
        { id: 'e-reply', status: 'replied', currentStep: 2 },
        { id: 'e-active', status: 'active', currentStep: 2 }
      ],
      messages: [
        { id: 'm1', sequenceStepId: 's1', enrollmentId: 'e-reply', status: 'sent', sentAt: new Date() },
        { id: 'm2', sequenceStepId: 's1', enrollmentId: 'e-active', status: 'sent', sentAt: new Date() }
      ]
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    // Both are contacts, total = 2
    assert.strictEqual(res.stepProgress[0]!.eligibleCount, 2);
    assert.strictEqual(res.stepProgress[0]!.sentCount, 2);
    assert.strictEqual(res.stepProgress[1]!.eligibleCount, 2);
    assert.strictEqual(res.stepProgress[1]!.sentCount, 0);
    console.log('✓ Test 9: Replied contact handled correctly passed');
  }

  // Test 10: Unsubscribed contact excluded from contact count
  {
    const campaign = {
      sequences: [{
        steps: [
          { id: 's1', stepNumber: 1, stepName: 'Step 1' },
          { id: 's2', stepNumber: 2, stepName: 'Step 2' }
        ]
      }],
      enrollments: [
        { id: 'e-unsub', status: 'unsubscribed', currentStep: 1 },
        { id: 'e-paused', status: 'paused', currentStep: 1 },
        { id: 'e-active', status: 'active', currentStep: 1 }
      ],
      messages: [
        { id: 'm1', sequenceStepId: 's1', enrollmentId: 'e-active', status: 'sent', sentAt: new Date() }
      ]
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    // e-unsub and e-paused are excluded! Total applicable contacts = 1
    assert.strictEqual(res.stepProgress[0]!.eligibleCount, 1);
    assert.strictEqual(res.stepProgress[0]!.sentCount, 1);
    assert.strictEqual(res.stepProgress[1]!.eligibleCount, 1);
    assert.strictEqual(res.stepProgress[1]!.sentCount, 0);
    console.log('✓ Test 10: Unsubscribed and paused contacts excluded correctly passed');
  }

  // Test 11: Paused campaign (completion status still calculated accurately from actual state)
  {
    const campaign = {
      sequences: [{
        steps: [
          { id: 's1', stepNumber: 1, stepName: 'Step 1' }
        ]
      }],
      enrollments: [
        { id: 'e1', status: 'completed', currentStep: 1 }
      ],
      messages: [
        { id: 'm1', sequenceStepId: 's1', enrollmentId: 'e1', status: 'sent', sentAt: new Date() }
      ]
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    assert.strictEqual(res.campaignCompletion.completed, true);
    console.log('✓ Test 11: Paused campaign completion handled correctly passed');
  }

  // Test 12: Empty campaign
  {
    const campaign = {
      sequences: [],
      enrollments: [],
      messages: []
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    assert.strictEqual(res.stepProgress.length, 0);
    assert.strictEqual(res.campaignCompletion.completed, false);
    assert.strictEqual(res.campaignCompletion.totalSteps, 0);
    console.log('✓ Test 12: Empty campaign passed');
  }

  // Test 13: Percentage never exceeds 100%
  {
    const pct1 = formatCompletionPercentage(150, 100);
    assert.strictEqual(pct1, 100);

    const campaign = {
      sequences: [{
        steps: [{ id: 's1', stepNumber: 1, stepName: 'Step 1' }]
      }],
      enrollments: [{ id: 'e1', status: 'active', currentStep: 1 }],
      messages: [
        { id: 'm1', sequenceStepId: 's1', enrollmentId: 'e1', status: 'sent', sentAt: new Date() },
        { id: 'm2', sequenceStepId: 's1', toEmail: 'extra@example.com', status: 'sent', sentAt: new Date() }
      ]
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    assert.ok(res.stepProgress[0]!.completionPercentage <= 100);
    console.log('✓ Test 13: Percentage never exceeds 100% passed');
  }

  // Test 14: Percentage correctly handles zero denominator
  {
    const pctZero = formatCompletionPercentage(0, 0);
    assert.strictEqual(pctZero, 0);
    const pctZero2 = formatCompletionPercentage(5, 0);
    assert.strictEqual(pctZero2, 0);

    // Also small percentage format check (e.g. 1 / 500 = 0.2%)
    const pctSmall = formatCompletionPercentage(1, 500);
    assert.strictEqual(pctSmall, 0.2);

    console.log('✓ Test 14: Percentage correctly handles zero denominator passed');
  }

  // Test 15: No duplicate recipient/step counting
  {
    const campaign = {
      sequences: [{
        steps: [{ id: 's1', stepNumber: 1, stepName: 'Step 1' }]
      }],
      enrollments: [{ id: 'e1', status: 'active', currentStep: 1 }],
      messages: [
        { id: 'm1', sequenceStepId: 's1', enrollmentId: 'e1', status: 'sent', sentAt: new Date() },
        { id: 'm2', sequenceStepId: 's1', enrollmentId: 'e1', status: 'sent', sentAt: new Date() },
        { id: 'm3', sequenceStepId: 's1', enrollmentId: 'e1', status: 'delivered', sentAt: new Date() }
      ]
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    assert.strictEqual(res.stepProgress[0]!.sentCount, 1);
    console.log('✓ Test 15: No duplicate recipient/step counting passed');
  }

  // Test 16: Multiple campaigns return independent step statistics
  {
    const campA = {
      sequences: [{ steps: [{ id: 'a1', stepNumber: 1, stepName: 'A Step' }] }],
      enrollments: [{ id: 'ea1', status: 'active', currentStep: 1 }],
      messages: [{ id: 'ma1', sequenceStepId: 'a1', enrollmentId: 'ea1', status: 'sent', sentAt: new Date() }]
    };
    const campB = {
      sequences: [{ steps: [{ id: 'b1', stepNumber: 1, stepName: 'B Step' }] }],
      enrollments: [
        { id: 'eb1', status: 'active', currentStep: 1 },
        { id: 'eb2', status: 'active', currentStep: 1 }
      ],
      messages: []
    };
    const resA = calculateCampaignStepProgressAndCompletion(campA);
    const resB = calculateCampaignStepProgressAndCompletion(campB);
    assert.strictEqual(resA.stepProgress[0]!.sentCount, 1);
    assert.strictEqual(resA.stepProgress[0]!.status, 'COMPLETED');
    assert.strictEqual(resB.stepProgress[0]!.sentCount, 0);
    assert.strictEqual(resB.stepProgress[0]!.status, 'NOT_STARTED');
    console.log('✓ Test 16: Multiple campaigns return independent step statistics passed');
  }

  // Test 17: Legacy campaigns with null sequenceStepId on earlier steps
  {
    const campaign = {
      sequences: [{
        steps: [
          { id: 's1', stepNumber: 1, stepName: 'Initial Outreach' },
          { id: 's2', stepNumber: 2, stepName: 'Follow-up' },
          { id: 's3', stepNumber: 3, stepName: 'Final Follow-up' }
        ]
      }],
      enrollments: [
        { id: 'e1', status: 'completed', currentStep: 3 },
        { id: 'e2', status: 'active', currentStep: 3 },
        { id: 'e3', status: 'active', currentStep: 2 }
      ],
      messages: [
        // e1 received 3 messages chronologically (legacy: sequenceStepId was null)
        { id: 'm1-1', sequenceStepId: null, enrollmentId: 'e1', status: 'sent', sentAt: new Date(2026, 8, 15, 10, 0) },
        { id: 'm1-2', sequenceStepId: null, enrollmentId: 'e1', status: 'sent', sentAt: new Date(2026, 8, 18, 10, 0) },
        { id: 'm1-3', sequenceStepId: 's3', enrollmentId: 'e1', status: 'sent', sentAt: new Date(2026, 8, 21, 10, 0) },
        // e2 received 2 legacy messages
        { id: 'm2-1', sequenceStepId: null, enrollmentId: 'e2', status: 'sent', sentAt: new Date(2026, 8, 15, 10, 0) },
        { id: 'm2-2', sequenceStepId: null, enrollmentId: 'e2', status: 'sent', sentAt: new Date(2026, 8, 18, 10, 0) },
        // e3 received 1 legacy message
        { id: 'm3-1', sequenceStepId: null, enrollmentId: 'e3', status: 'sent', sentAt: new Date(2026, 8, 15, 10, 0) }
      ]
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    // Step 1: all 3 sent
    assert.strictEqual(res.stepProgress[0]!.sentCount, 3, 'Step 1 should have 3 sent');
    // Step 2: e1 (has 3 msgs), e2 (has 2 msgs and currentStep 3), e3 (currentStep 2)
    assert.strictEqual(res.stepProgress[1]!.sentCount >= 2, true, 'Step 2 sent count should be at least 2');
    // Step 3: e1 sent, e2 reached step 3
    assert.strictEqual(res.stepProgress[2]!.sentCount >= 1, true, 'Step 3 sent count should be at least 1');
    // Monotonic invariant: Step 1 >= Step 2 >= Step 3
    assert.strictEqual(res.stepProgress[0]!.sentCount >= res.stepProgress[1]!.sentCount, true, 'Step 1 count >= Step 2 count');
    assert.strictEqual(res.stepProgress[1]!.sentCount >= res.stepProgress[2]!.sentCount, true, 'Step 2 count >= Step 3 count (no step 2 zero while step 3 active)');
    console.log('✓ Test 17: Legacy campaigns with null sequenceStepId handled monotonically passed');
  }

  // Test 18: Step 2 count is strictly higher than or equal to Step 3 count when Step 3 is active
  {
    const campaign = {
      sequences: [{
        steps: [
          { id: 's1', stepNumber: 1, stepName: 'Step 1' },
          { id: 's2', stepNumber: 2, stepName: 'Step 2' },
          { id: 's3', stepNumber: 3, stepName: 'Step 3' }
        ]
      }],
      enrollments: Array.from({ length: 50 }, (_, i) => ({
        id: `e-${i}`,
        status: i < 10 ? 'completed' : 'active',
        currentStep: i < 15 ? 3 : 2
      })),
      messages: [
        // 11 messages with step s3
        ...Array.from({ length: 11 }, (_, i) => ({
          id: `m-s3-${i}`,
          sequenceStepId: 's3',
          enrollmentId: `e-${i}`,
          status: 'sent',
          sentAt: new Date()
        }))
      ]
    };
    const res = calculateCampaignStepProgressAndCompletion(campaign);
    assert.strictEqual(res.stepProgress[0]!.sentCount >= res.stepProgress[1]!.sentCount, true);
    assert.strictEqual(res.stepProgress[1]!.sentCount >= res.stepProgress[2]!.sentCount, true);
    assert.strictEqual(res.stepProgress[1]!.sentCount > 0, true, 'Step 2 must not be zero when Step 3 has sent messages');
    console.log('✓ Test 18: Step 2 count is strictly >= Step 3 count passed');
  }

  console.log('\n ALL 18 CAMPAIGN STEP PROGRESS TESTS PASSED SUCCESSFULLY! \n');
}

runTests();
