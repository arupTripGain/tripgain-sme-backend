import 'dotenv/config';
import assert from 'assert';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import {
  createBulkCampaign,
  getBulkCampaignById,
  getBulkCampaignPreflight,
  queueBulkCampaign
} from '../src/controllers/bulkEmailController';
import {
  composeCampaign,
  getEligibilityPreview,
  activateCampaign,
  getCampaignById
} from '../src/controllers/campaignController';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'tripgain_dev_jwt_secret_change_in_production';

function createMockReqRes(options: {
  token?: string | null;
  user?: any;
  params?: Record<string, string>;
  query?: Record<string, any>;
  body?: any;
}) {
  let statusCode = 200;
  let responseData: any = null;

  const req: any = {
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    params: options.params || {},
    query: options.query || {},
    body: options.body || {},
    user: options.user
  };

  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      responseData = data;
      return res;
    },
    send(data: any) {
      responseData = data;
      return res;
    }
  };

  return {
    req,
    res,
    getStatus: () => statusCode,
    getData: () => responseData
  };
}

async function runMultiListSuite() {
  console.log('====================================================');
  console.log('  RUNNING MULTI-LIST AUDIENCE TESTS (BULK & CAMPAIGN) ');
  console.log('====================================================\n');

  const timestamp = Date.now();
  const testEmail = `test_multilist_${timestamp}@tripgain.local`;

  // 1. Create User & Workspace
  const user = await prisma.user.create({
    data: {
      email: testEmail,
      name: 'MultiList Tester',
      role: 'ADMIN'
    }
  });

  const workspace = await prisma.workspace.create({
    data: {
      name: `MultiList Workspace ${timestamp}`,
      userId: user.id
    }
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { workspaceId: workspace.id }
  });

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role, workspaceId: workspace.id },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
  const authUser = { userId: user.id, email: user.email, role: user.role, workspaceId: workspace.id };

  // 2. Create Mailbox
  const mailbox = await prisma.mailbox.create({
    data: {
      userId: user.id,
      workspaceId: workspace.id,
      email: `sender_${timestamp}@tripgain.local`,
      displayName: 'MultiList Sender',
      provider: 'SMTP_IMAP',
      connectionType: 'SMTP_IMAP',
      status: 'ACTIVE',
      dailySendLimit: 200,
      hourlySendLimit: 50,
      isActive: true
    }
  });

  // 3. Create List A and List B
  const listA = await prisma.list.create({
    data: {
      workspaceId: workspace.id,
      userId: user.id,
      name: `Audience List Alpha ${timestamp}`,
      listType: 'static'
    }
  });

  const listB = await prisma.list.create({
    data: {
      workspaceId: workspace.id,
      userId: user.id,
      name: `Audience List Beta ${timestamp}`,
      listType: 'static'
    }
  });

  // 4. Create Contacts:
  // Contact 1: in List A only
  // Contact 2: in List B only
  // Contact 3: in BOTH List A and List B (overlap)
  const contact1 = await prisma.contact.create({
    data: {
      workspaceId: workspace.id,
      userId: user.id,
      firstName: 'Alice',
      lastName: 'Alpha',
      emails: {
        create: {
          email: `alice_${timestamp}@company-a.com`,
          normalizedEmail: `alice_${timestamp}@company-a.com`,
          isPrimary: true,
          isValid: true,
          verificationStatus: 'verified'
        }
      },
      listMemberships: {
        create: { listId: listA.id }
      }
    }
  });

  const contact2 = await prisma.contact.create({
    data: {
      workspaceId: workspace.id,
      userId: user.id,
      firstName: 'Bob',
      lastName: 'Beta',
      emails: {
        create: {
          email: `bob_${timestamp}@company-b.com`,
          normalizedEmail: `bob_${timestamp}@company-b.com`,
          isPrimary: true,
          isValid: true,
          verificationStatus: 'verified'
        }
      },
      listMemberships: {
        create: { listId: listB.id }
      }
    }
  });

  const contact3 = await prisma.contact.create({
    data: {
      workspaceId: workspace.id,
      userId: user.id,
      firstName: 'Charlie',
      lastName: 'Common',
      emails: {
        create: {
          email: `charlie_${timestamp}@company-common.com`,
          normalizedEmail: `charlie_${timestamp}@company-common.com`,
          isPrimary: true,
          isValid: true,
          verificationStatus: 'verified'
        }
      },
      listMemberships: {
        create: [
          { listId: listA.id },
          { listId: listB.id }
        ]
      }
    }
  });

  try {
    // -----------------------------------------------------------------
    // TEST 1: Bulk Campaign Creation with Multiple List IDs
    // -----------------------------------------------------------------
    console.log('--- TEST 1: Create Bulk Campaign with Multiple List IDs ---');
    const createBulkReqRes = createMockReqRes({
      token,
      user: authUser,
      body: {
        name: `Multi-List Bulk Announcement ${timestamp}`,
        listIds: [listA.id, listB.id],
        senderMailboxes: [mailbox.id],
        subject: 'Important Update {{firstName}}',
        bodyHtml: '<p>Hi {{firstName}}, check our update! <a href="{{unsubscribeLink}}">Unsubscribe</a></p>'
      }
    });

    await createBulkCampaign(createBulkReqRes.req, createBulkReqRes.res);
    assert.strictEqual(createBulkReqRes.getStatus(), 201, 'Should create bulk campaign successfully');
    const bulkCamp = createBulkReqRes.getData();
    assert.ok(bulkCamp.id, 'Campaign must have an ID');
    assert.deepStrictEqual(bulkCamp.listIds, [listA.id, listB.id], 'Campaign listIds must store both list IDs');
    assert.strictEqual(bulkCamp.listId, listA.id, 'Legacy listId must default to first list ID');
    console.log('✔ Test 1 passed: Bulk campaign created with listIds array and primary listId fallback.\n');

    // -----------------------------------------------------------------
    // TEST 2: Bulk Campaign Details Returns Multiple Lists
    // -----------------------------------------------------------------
    console.log('--- TEST 2: Get Bulk Campaign Details with Multiple Lists ---');
    const getBulkReqRes = createMockReqRes({
      token,
      user: authUser,
      params: { id: bulkCamp.id }
    });

    await getBulkCampaignById(getBulkReqRes.req, getBulkReqRes.res);
    assert.strictEqual(getBulkReqRes.getStatus(), 200);
    const bulkDetail = getBulkReqRes.getData();
    assert.strictEqual(bulkDetail.lists.length, 2, 'Should return enriched lists array containing both lists');
    assert.ok(bulkDetail.lists.some((l: any) => l.id === listA.id), 'Must include List A');
    assert.ok(bulkDetail.lists.some((l: any) => l.id === listB.id), 'Must include List B');
    console.log('✔ Test 2 passed: Details returns both lists correctly.\n');

    // -----------------------------------------------------------------
    // TEST 3: Pre-flight Audit Across Multiple Lists with Deduplication
    // -----------------------------------------------------------------
    console.log('--- TEST 3: Bulk Pre-flight Deduplication Across Multiple Lists ---');
    const preflightReqRes = createMockReqRes({
      token,
      user: authUser,
      params: { id: bulkCamp.id },
      query: { listIds: `${listA.id},${listB.id}` }
    });

    await getBulkCampaignPreflight(preflightReqRes.req, preflightReqRes.res);
    assert.strictEqual(preflightReqRes.getStatus(), 200);
    const preflight = preflightReqRes.getData();

    // List A has contact1, contact3 (2 members). List B has contact2, contact3 (2 members). Total raw = 4 members.
    assert.strictEqual(preflight.audience.rawListSize, 4, 'Raw list size across both lists is 4');
    assert.strictEqual(preflight.audience.duplicateCount, 1, 'Overlapping contact3 must be identified as 1 duplicate');
    assert.strictEqual(preflight.audience.finalEligibleCount, 3, 'Unique eligible contacts must equal exactly 3');
    assert.strictEqual(preflight.isReadyToQueue, true, 'Campaign should be ready to queue');
    console.log('✔ Test 3 passed: Pre-flight deduplicated overlapping contacts across multiple lists.\n');

    // -----------------------------------------------------------------
    // TEST 4: Queue Recipients Enrolls Deduplicated Contacts from Multiple Lists
    // -----------------------------------------------------------------
    console.log('--- TEST 4: Queue Bulk Campaign Enrolls Deduplicated Contacts ---');
    const queueReqRes = createMockReqRes({
      token,
      user: authUser,
      params: { id: bulkCamp.id },
      body: {}
    });

    await queueBulkCampaign(queueReqRes.req, queueReqRes.res);
    assert.strictEqual(queueReqRes.getStatus(), 200);
    const queueData = queueReqRes.getData();
    assert.strictEqual(queueData.queuedCount, 3, 'Exactly 3 unique recipients queued');

    const enrollments = await prisma.enrollment.findMany({
      where: { campaignId: bulkCamp.id }
    });
    assert.strictEqual(enrollments.length, 3, 'Database must have exactly 3 enrollments');
    const enrolledContactIds = new Set(enrollments.map(e => e.contactId));
    assert.ok(enrolledContactIds.has(contact1.id));
    assert.ok(enrolledContactIds.has(contact2.id));
    assert.ok(enrolledContactIds.has(contact3.id));
    console.log('✔ Test 4 passed: Exactly 3 unique contacts enrolled without duplication.\n');

    // -----------------------------------------------------------------
    // TEST 5: Compose Outreach Campaign with Multiple Lists
    // -----------------------------------------------------------------
    console.log('--- TEST 5: Compose Outreach Campaign with Multiple Lists ---');
    const composeReqRes = createMockReqRes({
      token,
      user: authUser,
      body: {
        name: `Outreach Multi-List Campaign ${timestamp}`,
        campaignCode: `OUTREACH_${timestamp}`,
        listIds: [listA.id, listB.id],
        senderMailboxes: [mailbox.email],
        sequenceSteps: [
          { type: 'email', delayDays: 0, subject: 'Hello {{firstName}}', body: 'Hi {{firstName}}' }
        ]
      }
    });

    await composeCampaign(composeReqRes.req, composeReqRes.res);
    assert.strictEqual(composeReqRes.getStatus(), 201);
    const outreachCamp = composeReqRes.getData();
    assert.deepStrictEqual(outreachCamp.listIds, [listA.id, listB.id]);
    assert.strictEqual(outreachCamp.listId, listA.id);
    console.log('✔ Test 5 passed: Outreach campaign composed with multiple listIds.\n');

    // -----------------------------------------------------------------
    // TEST 6: Campaign Eligibility Preview Across Multiple Lists
    // -----------------------------------------------------------------
    console.log('--- TEST 6: Campaign Eligibility Preview with Multiple Lists ---');
    const eligReqRes = createMockReqRes({
      token,
      user: authUser,
      query: { listIds: `${listA.id},${listB.id}` }
    });

    await getEligibilityPreview(eligReqRes.req, eligReqRes.res);
    assert.strictEqual(eligReqRes.getStatus(), 200);
    const eligData = eligReqRes.getData();
    assert.strictEqual(eligData.totalContacts, 3, 'Eligibility preview returns 3 unique contacts');
    assert.strictEqual(eligData.eligibleContacts, 3);
    console.log('✔ Test 6 passed: Eligibility preview deduplicated across multiple lists.\n');

    // -----------------------------------------------------------------
    // TEST 7: Activate Outreach Campaign Enrolls All Unique Contacts from Multiple Lists
    // -----------------------------------------------------------------
    console.log('--- TEST 7: Activate Campaign Enrolls Contacts from All Lists ---');
    const activateReqRes = createMockReqRes({
      token,
      user: authUser,
      params: { id: outreachCamp.id }
    });

    await activateCampaign(activateReqRes.req, activateReqRes.res);
    assert.strictEqual(activateReqRes.getStatus(), 200);
    const activateData = activateReqRes.getData();
    assert.strictEqual(activateData.enrolledCount, 3, 'Enrolled 3 contacts into outreach campaign');

    const outreachEnrollments = await prisma.enrollment.findMany({
      where: { campaignId: outreachCamp.id }
    });
    assert.strictEqual(outreachEnrollments.length, 3, 'Exactly 3 enrollments in database');
    console.log('✔ Test 7 passed: Activated campaign correctly enrolled contacts from all lists.\n');

    // -----------------------------------------------------------------
    // TEST 8: Campaign Details Returns Multiple Lists Enriched
    // -----------------------------------------------------------------
    console.log('--- TEST 8: Get Outreach Campaign Details with Multiple Lists ---');
    const getCampReqRes = createMockReqRes({
      token,
      user: authUser,
      params: { id: outreachCamp.id }
    });

    await getCampaignById(getCampReqRes.req, getCampReqRes.res);
    assert.strictEqual(getCampReqRes.getStatus(), 200);
    const campDetail = getCampReqRes.getData();
    assert.strictEqual(campDetail.lists.length, 2);
    assert.deepStrictEqual(campDetail.listIds, [listA.id, listB.id]);
    console.log('✔ Test 8 passed: Campaign details returns lists and listIds.\n');

    console.log('====================================================');
    console.log('  ALL 8 MULTI-LIST AUDIENCE TESTS PASSED! 🎉        ');
    console.log('====================================================\n');

  } finally {
    // Cleanup created records
    await prisma.enrollment.deleteMany({
      where: { campaign: { workspaceId: workspace.id } }
    });
    await prisma.sequenceStep.deleteMany({
      where: { sequence: { campaign: { workspaceId: workspace.id } } }
    });
    await prisma.sequence.deleteMany({
      where: { campaign: { workspaceId: workspace.id } }
    });
    await prisma.auditLog.deleteMany({
      where: { campaign: { workspaceId: workspace.id } }
    });
    await prisma.campaign.deleteMany({
      where: { workspaceId: workspace.id }
    });
    await prisma.listMember.deleteMany({
      where: { listId: { in: [listA.id, listB.id] } }
    });
    await prisma.contactEmail.deleteMany({
      where: { contactId: { in: [contact1.id, contact2.id, contact3.id] } }
    });
    await prisma.contact.deleteMany({
      where: { workspaceId: workspace.id }
    });
    await prisma.list.deleteMany({
      where: { id: { in: [listA.id, listB.id] } }
    });
    await prisma.mailboxCredential.deleteMany({
      where: { mailboxId: mailbox.id }
    });
    await prisma.mailbox.deleteMany({
      where: { id: mailbox.id }
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { workspaceId: null }
    });
    await prisma.workspace.deleteMany({
      where: { id: workspace.id }
    });
    await prisma.user.deleteMany({
      where: { id: user.id }
    });
    await prisma.$disconnect();
  }
}

runMultiListSuite().catch(err => {
  console.error('Multi-List Test Suite Failed:', err);
  process.exit(1);
});
