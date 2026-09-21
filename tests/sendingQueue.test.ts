import assert from 'assert';
import { calculateSendingQueueSummary, clearSendingQueueCache } from '../src/controllers/dashboardController';
import { getCalendarBucketBounds } from '../src/services/quotaService';
import { getZonedParts } from '../src/utils/businessDays';

console.log('====================================================');
console.log('RUNNING SENDING QUEUE SUMMARY LOGIC UNIT TESTS');
console.log('Pure Synthetic / In-Memory Mock Tests');
console.log('====================================================\n');

async function runTests() {
  // Test 1: Date bounds in Asia/Kolkata
  {
    const testDate = new Date('2026-09-21T10:00:00.000Z'); // 15:30 IST on Monday Sep 21
    const bounds = getCalendarBucketBounds(testDate, 'Asia/Kolkata');
    assert.strictEqual(bounds.currentDayOfWeek, 'MON', 'Day of week should be MON');
    assert.strictEqual(bounds.timeZone, 'Asia/Kolkata', 'Timezone should be Asia/Kolkata');
    console.log('✔ Test 1 passed: getCalendarBucketBounds correctly identifies Asia/Kolkata date and day');
  }

  // Test 2: calculateSendingQueueSummary with empty campaigns
  {
    const mockClient = {
      campaign: {
        findMany: async () => []
      }
    };
    const result = await calculateSendingQueueSummary(
      { userId: 'test-user-1' },
      mockClient,
      new Date('2026-09-21T10:00:00.000Z')
    );

    assert.strictEqual(result.timezone, 'Asia/Kolkata');
    assert.strictEqual(result.today.planned, 0);
    assert.strictEqual(result.today.sent, 0);
    assert.strictEqual(result.today.queued, 0);
    assert.strictEqual(result.today.progressPercent, 0);
    assert.strictEqual(result.tomorrow.queued, 0);
    assert.strictEqual(result.next3Days.totalQueued, 0);
    assert.deepStrictEqual(result.next3Days.days, []);
    console.log('✔ Test 2 passed: Returns empty queue state cleanly when user has no campaigns');
  }

  // Test 3: calculateSendingQueueSummary with active campaigns and normal scheduled leads
  {
    const mockUser = { userId: 'user-arup', name: 'Arup', email: 'arup@tripgainapp.com' };
    const mockCampaigns = [
      {
        id: 'camp-1',
        name: 'SME Outreach',
        status: 'active',
        approvalStatus: 'APPROVED',
        dailySendLimit: 1000,
        sendingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        senderMailboxes: ['mb-1'],
        timezone: 'Asia/Kolkata'
      }
    ];

    const mockMailboxes = [
      {
        id: 'mb-1',
        email: 'arup@tripgainapp.com',
        dailySendLimit: 1000,
        sendingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        sendingTimezone: 'Asia/Kolkata',
        status: 'CONNECTED',
        isActive: true
      }
    ];

    const mockClient = {
      campaign: {
        findMany: async () => mockCampaigns
      },
      emailMessage: {
        count: async (args: any) => {
          // Sent today count
          return 500;
        }
      },
      mailbox: {
        findMany: async () => mockMailboxes
      },
      suppressionList: {
        count: async () => 0,
        findMany: async () => []
      },
      enrollment: {
        count: async (args: any) => {
          if (args.where.OR && args.where.OR.some((c: any) => c.nextSendAt?.lte !== undefined)) {
            // Today count
            return 500;
          }
          // Tomorrow or day 2/3
          const gte = args.where.nextSendAt?.gte;
          if (gte) {
            // Tomorrow (Sep 22)
            if (gte.toISOString().includes('2026-09-21T18:30:00')) {
              return 1000;
            }
            // Day 2 (Sep 23)
            if (gte.toISOString().includes('2026-09-22T18:30:00')) {
              return 500;
            }
            // Day 3 (Sep 24)
            if (gte.toISOString().includes('2026-09-23T18:30:00')) {
              return 350;
            }
          }
          return 0;
        }
      }
    };

    const result = await calculateSendingQueueSummary(
      mockUser,
      mockClient,
      new Date('2026-09-21T10:00:00.000Z') // Monday Sep 21
    );

    assert.strictEqual(result.timezone, 'Asia/Kolkata');
    assert.strictEqual(result.today.date, '2026-09-21');
    assert.strictEqual(result.today.sent, 500);
    assert.strictEqual(result.today.queued, 500);
    assert.strictEqual(result.today.planned, 1000);
    assert.strictEqual(result.today.progressPercent, 50);

    assert.strictEqual(result.tomorrow.date, '2026-09-22');
    assert.strictEqual(result.tomorrow.queued, 1000);

    assert.strictEqual(result.next3Days.totalQueued, 1850);
    assert.strictEqual(result.next3Days.days.length, 3);
    assert.strictEqual(result.next3Days.days[0]!.date, '2026-09-22');
    assert.strictEqual(result.next3Days.days[0]!.queued, 1000);
    assert.strictEqual(result.next3Days.days[1]!.date, '2026-09-23');
    assert.strictEqual(result.next3Days.days[1]!.queued, 500);
    assert.strictEqual(result.next3Days.days[2]!.date, '2026-09-24');
    assert.strictEqual(result.next3Days.days[2]!.queued, 350);

    console.log('✔ Test 3 passed: Correctly computes Today (500 sent, 500 queued, 1000 planned, 50%), Tomorrow (1000), and Next 3 Days (1850 total with breakdown)');
  }

  // Test 4: Sending-day logic enforcement (e.g. Friday test -> Saturday tomorrow has 0 queued)
  {
    const mockUser = { userId: 'user-arup', name: 'Arup', email: 'arup@tripgainapp.com' };
    const mockCampaigns = [
      {
        id: 'camp-1',
        name: 'Mon-Fri Campaign',
        status: 'active',
        approvalStatus: 'APPROVED',
        dailySendLimit: 100,
        sendingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        senderMailboxes: ['mb-1'],
        timezone: 'Asia/Kolkata'
      }
    ];

    const mockMailboxes = [
      {
        id: 'mb-1',
        email: 'arup@tripgainapp.com',
        dailySendLimit: 100,
        sendingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        sendingTimezone: 'Asia/Kolkata',
        status: 'CONNECTED',
        isActive: true
      }
    ];

    let enrollmentQueryCount = 0;
    const mockClient = {
      campaign: { findMany: async () => mockCampaigns },
      emailMessage: { count: async () => 100 },
      mailbox: { findMany: async () => mockMailboxes },
      suppressionList: { count: async () => 0, findMany: async () => [] },
      enrollment: {
        count: async () => {
          enrollmentQueryCount++;
          return 200;
        }
      }
    };

    // Test on Friday Sep 25, 2026
    const fridayDate = new Date('2026-09-25T06:00:00.000Z'); // 11:30 IST Friday
    const result = await calculateSendingQueueSummary(mockUser, mockClient, fridayDate);

    // Tomorrow is Saturday (not a sending day for Mon-Fri campaign)
    assert.strictEqual(result.tomorrow.queued, 0, 'Tomorrow (Saturday) must be 0 queued for Mon-Fri campaign');
    console.log('✔ Test 4 passed: Business-day logic correctly zeroes Saturday/Sunday queue when campaign does not send on weekends');
  }

  // Test 5: Inactive or unapproved campaigns do not contribute to queued
  {
    const mockUser = { userId: 'user-arup' };
    const mockCampaigns = [
      {
        id: 'camp-draft',
        name: 'Draft Campaign',
        status: 'draft',
        approvalStatus: 'DRAFT',
        dailySendLimit: 100,
        sendingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        senderMailboxes: ['mb-1'],
        timezone: 'Asia/Kolkata'
      }
    ];

    const mockClient = {
      campaign: { findMany: async () => mockCampaigns },
      emailMessage: { count: async () => 0 },
      mailbox: { findMany: async () => [] },
      suppressionList: { count: async () => 0, findMany: async () => [] },
      enrollment: { count: async () => 999 } // Should not be called
    };

    const result = await calculateSendingQueueSummary(mockUser, mockClient, new Date('2026-09-21T10:00:00.000Z'));
    assert.strictEqual(result.today.queued, 0);
    assert.strictEqual(result.tomorrow.queued, 0);
    assert.strictEqual(result.next3Days.totalQueued, 0);
    console.log('✔ Test 5 passed: Draft/unapproved campaigns are excluded from queue calculation');
  }

  // Test 6: Exact user example calculation for Live Sending-Plan View
  // Campaign = 1,288 total leads
  // Sent today = 277
  // Today's capacity = 400
  // Remaining queue = 1,011
  // Expected:
  // Today sendable = MIN(1,011, 123) = 123
  // Future queue = 888
  // Planned = 400 (NOT 1,288!)
  {
    const mockUser = { userId: 'user-arup', name: 'Arup', email: 'arup@tripgainapp.com' };
    const mockCampaigns = [
      {
        id: 'camp-example',
        name: 'Target Outreach Campaign',
        status: 'active',
        approvalStatus: 'APPROVED',
        dailySendLimit: 400,
        sendingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        senderMailboxes: ['mb-example'],
        timezone: 'Asia/Kolkata'
      }
    ];

    const mockMailboxes = [
      {
        id: 'mb-example',
        email: 'arup@tripgainapp.com',
        dailySendLimit: 400,
        sendingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        sendingTimezone: 'Asia/Kolkata',
        status: 'CONNECTED',
        isActive: true
      }
    ];

    const mockClient = {
      campaign: { findMany: async () => mockCampaigns },
      emailMessage: { count: async () => 277 }, // Sent today = 277
      mailbox: { findMany: async () => mockMailboxes },
      suppressionList: { count: async () => 0, findMany: async () => [] },
      enrollment: {
        count: async (args: any) => {
          if (args.where.OR && args.where.OR.some((c: any) => c.nextSendAt?.lte !== undefined)) {
            // Currently eligible queue = 1,011
            return 1011;
          }
          // Tomorrow scheduled sequence steps = 0
          return 0;
        }
      }
    };

    const result = await calculateSendingQueueSummary(mockUser, mockClient, new Date('2026-09-21T10:00:00.000Z'));

    // Verify 5 distinguished core metrics:
    assert.strictEqual(result.currentlyEligibleQueue, 1011, 'Currently eligible queue must be 1,011');
    assert.strictEqual(result.todaySendCapacity, 400, 'Today send capacity must be 400');
    assert.strictEqual(result.sentToday, 277, 'Sent today must be 277');
    assert.strictEqual(result.remainingTodayCapacity, 123, 'Remaining capacity must be 400 - 277 = 123');
    assert.strictEqual(result.todaySendable, 123, 'Today sendable must be MIN(1,011, 123) = 123');
    assert.strictEqual(result.remainingSendableToday, 123, 'Remaining sendable today must be 123');
    assert.strictEqual(result.futureQueue, 888, 'Future rollover queue must be 1,011 - 123 = 888');

    // Verify today's plan does NOT treat all campaign contacts as planned today:
    assert.strictEqual(result.today.planned, 400, 'Planned today must be sentToday + todaySendable = 400, NOT 1,288');
    assert.strictEqual(result.today.progressPercent, 69, 'Progress percent must be Math.round((277 / 400) * 100) = 69%');

    // Verify natural rollover into tomorrow:
    assert.strictEqual(result.tomorrow.queued, 888, 'Tomorrow queued must include the 888 future rollover queue');
    assert.strictEqual(result.tomorrow.rolloverQueue, 888, 'Tomorrow rolloverQueue must be 888');

    console.log('✔ Test 6 passed: Exact user example calculation verified (Cap: 400, Sent: 277, Eligible: 1011, Sendable: 123, Rollover: 888, Planned: 400)');
  }

  // Test 7: Rollover continuity when capacity is fully exhausted
  {
    const mockUser = { userId: 'user-arup', name: 'Arup', email: 'arup@tripgainapp.com' };
    const mockCampaigns = [
      {
        id: 'camp-exhausted',
        name: 'Full Capacity Campaign',
        status: 'active',
        approvalStatus: 'APPROVED',
        dailySendLimit: 200,
        sendingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        senderMailboxes: ['mb-1'],
        timezone: 'Asia/Kolkata'
      }
    ];

    const mockMailboxes = [
      {
        id: 'mb-1',
        email: 'arup@tripgainapp.com',
        dailySendLimit: 200,
        sendingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        sendingTimezone: 'Asia/Kolkata',
        status: 'CONNECTED',
        isActive: true
      }
    ];

    const mockClient = {
      campaign: { findMany: async () => mockCampaigns },
      emailMessage: { count: async () => 200 }, // Sent today = 200 (Capacity 100% reached)
      mailbox: { findMany: async () => mockMailboxes },
      suppressionList: { count: async () => 0, findMany: async () => [] },
      enrollment: {
        count: async (args: any) => {
          if (args.where.OR && args.where.OR.some((c: any) => c.nextSendAt?.lte !== undefined)) {
            return 350; // 350 eligible contacts waiting
          }
          return 50; // 50 scheduled tomorrow
        }
      }
    };

    const result = await calculateSendingQueueSummary(mockUser, mockClient, new Date('2026-09-21T10:00:00.000Z'));

    assert.strictEqual(result.todaySendCapacity, 200);
    assert.strictEqual(result.sentToday, 200);
    assert.strictEqual(result.remainingTodayCapacity, 0);
    assert.strictEqual(result.todaySendable, 0);
    assert.strictEqual(result.futureQueue, 350, 'All 350 waiting contacts must roll over into future queue');
    assert.strictEqual(result.tomorrow.queued, 400, 'Tomorrow must have 350 rollover + 50 scheduled = 400');
    assert.strictEqual(result.today.progressPercent, 100);

    console.log('✔ Test 7 passed: Rollover continuity preserved when daily capacity is fully exhausted (350 contacts rolled forward to tomorrow)');
  }

  // Test 8: In-memory snapshot cache management
  {
    assert.strictEqual(typeof clearSendingQueueCache, 'function', 'clearSendingQueueCache must be an exported function');
    clearSendingQueueCache('test-user');
    clearSendingQueueCache();
    console.log('✔ Test 8 passed: In-memory snapshot cache helper is valid and clears successfully');
  }

  console.log('\n====================================================');
  console.log('ALL SENDING QUEUE UNIT TESTS PASSED SUCCESSFULLY');
  console.log('====================================================\n');
}

runTests().catch(err => {
  console.error('Test failure:', err);
  process.exit(1);
});
