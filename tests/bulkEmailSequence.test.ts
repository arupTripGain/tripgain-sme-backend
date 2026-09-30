import 'dotenv/config';
import assert from 'assert';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import {
  getBulkCampaigns,
  getBulkCampaignById,
  createBulkCampaign,
  updateBulkCampaign,
  getBulkCampaignPreflight,
  sendBulkTestEmail
} from '../src/controllers/bulkEmailController';

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
  let headersSent = false;

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
      headersSent = true;
      return res;
    },
    send(data: any) {
      responseData = data;
      headersSent = true;
      return res;
    },
    get statusCode() {
      return statusCode;
    },
    get data() {
      return responseData;
    }
  };

  return { req, res };
}

async function runTests() {
  console.log('🚀 Starting Bulk Email Sequence Automated Tests...\n');

  let testMailbox: any = null;
  let testList: any = null;
  let testContact: any = null;
  let authToken = '';
  let authUserPayload: any = null;
  const createdCampaignIds: string[] = [];

  try {
    // 1. Fetch an existing user with workspace
    const user = await prisma.user.findFirst();
    assert.ok(user, 'At least one user must exist in the database');

    const workspaceId = user.workspaceId || 'default-workspace';
    authUserPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      name: user.name || 'Test User'
    };

    authToken = jwt.sign(authUserPayload, JWT_SECRET, { expiresIn: '1h' });

    const uniqueSuffix = Date.now().toString().slice(-6);

    // 2. Create test mailbox
    testMailbox = await prisma.mailbox.create({
      data: {
        userId: user.id,
        workspaceId,
        email: `seq_mb_${uniqueSuffix}@example.com`,
        displayName: 'Bulk Sequence Sender',
        provider: 'SMTP_IMAP',
        connectionType: 'SMTP_IMAP',
        status: 'ACTIVE',
        dailySendLimit: 150,
        hourlySendLimit: 30
      }
    });

    // 3. Create test list
    testList = await prisma.list.create({
      data: {
        userId: user.id,
        workspaceId,
        name: `Sequence Test List ${uniqueSuffix}`,
        listType: 'static'
      }
    });

    // 4. Create test contact with email & membership
    testContact = await prisma.contact.create({
      data: {
        userId: user.id,
        workspaceId,
        firstName: 'Jordan',
        lastName: 'Lee',
        jobTitle: 'VP Engineering',
        city: 'Austin',
        personalizedLine: 'Jordan is leading infrastructure modernization.',
        emails: {
          create: [
            {
              email: `jordan.lee_${uniqueSuffix}@example.com`,
              normalizedEmail: `jordan.lee_${uniqueSuffix}@example.com`.toLowerCase(),
              isPrimary: true,
              isValid: true,
              verificationStatus: 'valid'
            }
          ]
        }
      }
    });

    await prisma.listMember.create({
      data: {
        listId: testList.id,
        contactId: testContact.id
      }
    });

    console.log('✅ Test fixtures initialized successfully.\n');

    // ==================================================
    // TEST 1: Create Multi-Step Bulk Campaign
    // ==================================================
    console.log('--- TEST 1: Create Multi-Step Sequence Bulk Campaign ---');
    {
      const { req, res } = createMockReqRes({
        token: authToken,
        user: authUserPayload,
        body: {
          name: `Multi-Step Bulk Campaign ${uniqueSuffix}`,
          listIds: [testList.id],
          mailboxIds: [testMailbox.id],
          dailySendLimit: 50,
          sequenceSteps: [
            {
              stepNumber: 1,
              delayDays: 0,
              subject: 'Initial: Hello {{firstName}}',
              body: '<p>Hi {{firstName}}, check out our platform.<br>{{unsubscribe_link}}</p>'
            },
            {
              stepNumber: 2,
              delayDays: 3,
              subject: '', // Thread reply
              body: '<p>Quick follow-up {{firstName}}, did you see my note?<br>{{unsubscribe_link}}</p>'
            },
            {
              stepNumber: 3,
              delayDays: 5,
              subject: 'Final follow up for {{firstName}}',
              body: '<p>Last attempt to reach out {{firstName}}.<br>{{unsubscribe_link}}</p>'
            }
          ]
        }
      });

      await createBulkCampaign(req, res);
      assert.strictEqual(res.statusCode, 201, `Expected status 201, got ${res.statusCode}: ${JSON.stringify(res.data)}`);
      const camp = res.data;
      assert.ok(camp.id, 'Campaign must have an ID');
      createdCampaignIds.push(camp.id);

      assert.strictEqual(camp.stepsCount, 3, 'Campaign should reflect 3 stepsCount');
      assert.strictEqual(camp.steps.length, 3, 'Campaign should return 3 steps');
      assert.strictEqual(camp.steps[0].stepNumber, 1);
      assert.strictEqual(camp.steps[0].delayDays, 0);
      assert.strictEqual(camp.steps[1].stepNumber, 2);
      assert.strictEqual(camp.steps[1].delayDays, 3);
      assert.strictEqual(camp.steps[2].stepNumber, 3);
      assert.strictEqual(camp.steps[2].delayDays, 5);
      console.log('✅ TEST 1 PASSED: Multi-step sequence bulk campaign created with 3 steps');
    }

    // ==================================================
    // TEST 2: Fetch Campaign By ID & Verify Progress / Sequence Fields
    // ==================================================
    console.log('\n--- TEST 2: Fetch Campaign By ID & Verify Sequence Fields ---');
    {
      const campaignId = createdCampaignIds[0] as string;
      const { req, res } = createMockReqRes({
        token: authToken,
        user: authUserPayload,
        params: { id: campaignId }
      });

      await getBulkCampaignById(req, res);
      assert.strictEqual(res.statusCode, 200);
      const camp = res.data;
      assert.strictEqual(camp.id, campaignId);
      assert.strictEqual(camp.steps.length, 3);
      assert.strictEqual(camp.stepsCount, 3);
      assert.ok(Array.isArray(camp.stepProgress), 'stepProgress should be an array');
      assert.strictEqual(camp.stepProgress.length, 3, 'stepProgress should report on all 3 steps');
      assert.strictEqual(camp.stepProgress[0].stepNumber, 1);
      assert.strictEqual(camp.stepProgress[1].stepNumber, 2);
      assert.strictEqual(camp.stepProgress[2].stepNumber, 3);
      console.log('✅ TEST 2 PASSED: getBulkCampaignById returns ordered steps and stepProgress');
    }

    // ==================================================
    // TEST 3: Preflight Validation of Multi-Step Sequence
    // ==================================================
    console.log('\n--- TEST 3: Preflight Validation of Multi-Step Sequence ---');
    {
      const campaignId = createdCampaignIds[0] as string;
      const { req, res } = createMockReqRes({
        token: authToken,
        user: authUserPayload,
        params: { id: campaignId }
      });

      await getBulkCampaignPreflight(req, res);
      assert.strictEqual(res.statusCode, 200);
      const preflight = res.data;
      assert.strictEqual(preflight.template.hasSubject, true, 'Template hygiene should pass for valid step subjects');
      assert.strictEqual(preflight.template.hasBody, true, 'Template hygiene should pass for valid step bodies');
      assert.strictEqual(preflight.template.hasUnsubscribe, true, 'Unsubscribe tags present across all steps');
      assert.ok(Array.isArray(preflight.template.errors), 'Errors should be an array');
      console.log('✅ TEST 3 PASSED: Preflight template audit passed across all sequence steps');
    }

    // ==================================================
    // TEST 4: Safe Test Email Dispatched for Specific Sequence Step
    // ==================================================
    console.log('\n--- TEST 4: Safe Test Email for Specific Sequence Step ---');
    {
      const campaignId = createdCampaignIds[0] as string;
      const { req, res } = createMockReqRes({
        token: authToken,
        user: authUserPayload,
        params: { id: campaignId },
        body: {
          testEmail: 'tester_sandbox@example.com',
          stepNumber: 2
        }
      });

      await sendBulkTestEmail(req, res);
      assert.strictEqual(res.statusCode, 200);
      const testResult = res.data;
      assert.strictEqual(testResult.success, true);
      assert.strictEqual(testResult.stepNumber, 2, 'Should report dispatching step 2');
      console.log('✅ TEST 4 PASSED: Safe test email successfully targeted step 2');
    }

    // ==================================================
    // TEST 5: Update Multi-Step Sequence (Adding a Step & Modifying Delays)
    // ==================================================
    console.log('\n--- TEST 5: Update Sequence Steps via updateBulkCampaign ---');
    {
      const campaignId = createdCampaignIds[0] as string;
      const { req, res } = createMockReqRes({
        token: authToken,
        user: authUserPayload,
        params: { id: campaignId },
        body: {
          name: `Updated Multi-Step Campaign ${uniqueSuffix}`,
          sequenceSteps: [
            {
              stepNumber: 1,
              delayDays: 0,
              subject: 'Updated Step 1: {{firstName}}',
              body: '<p>Updated initial message.<br>{{unsubscribe_link}}</p>'
            },
            {
              stepNumber: 2,
              delayDays: 4, // updated delay
              subject: 'Updated Step 2 Subject',
              body: '<p>Updated follow-up body.<br>{{unsubscribe_link}}</p>'
            }
          ]
        }
      });

      await updateBulkCampaign(req, res);
      assert.strictEqual(res.statusCode, 200);
      const updated = res.data;
      assert.strictEqual(updated.name, `Updated Multi-Step Campaign ${uniqueSuffix}`);
      assert.strictEqual(updated.stepsCount, 2, 'Should now have 2 steps');
      assert.strictEqual(updated.steps.length, 2);
      assert.strictEqual(updated.steps[1].delayDays, 4);
      assert.strictEqual(updated.steps[1].subject, 'Updated Step 2 Subject');
      console.log('✅ TEST 5 PASSED: Campaign sequence steps updated cleanly');
    }

    // ==================================================
    // TEST 6: Backward Compatibility: Single-Step Campaign Creation
    // ==================================================
    console.log('\n--- TEST 6: Single-Step Campaign Legacy Compatibility ---');
    {
      const { req, res } = createMockReqRes({
        token: authToken,
        user: authUserPayload,
        body: {
          name: `Single Step Legacy Bulk ${uniqueSuffix}`,
          listIds: [testList.id],
          mailboxIds: [testMailbox.id],
          subjectTemplate: 'Single blast subject for {{firstName}}',
          bodyHtmlTemplate: '<p>Single blast body {{unsubscribe_link}}</p>'
        }
      });

      await createBulkCampaign(req, res);
      assert.strictEqual(res.statusCode, 201);
      const camp = res.data;
      createdCampaignIds.push(camp.id);
      assert.strictEqual(camp.stepsCount, 1);
      assert.strictEqual(camp.steps.length, 1);
      assert.strictEqual(camp.steps[0].stepNumber, 1);
      assert.strictEqual(camp.steps[0].delayDays, 0);
      assert.strictEqual(camp.steps[0].subject, 'Single blast subject for {{firstName}}');
      console.log('✅ TEST 6 PASSED: Legacy single-step payloads remain 100% compatible');
    }

    // ==================================================
    // TEST 7: Listing Verification (getBulkCampaigns includes stepsCount)
    // ==================================================
    console.log('\n--- TEST 7: Listing Verification (getBulkCampaigns) ---');
    {
      const { req, res } = createMockReqRes({
        token: authToken,
        user: authUserPayload,
        query: { scope: 'my' }
      });

      await getBulkCampaigns(req, res);
      assert.strictEqual(res.statusCode, 200);
      const list = res.data;
      assert.ok(Array.isArray(list));
      const foundMulti = list.find((c: any) => c.id === createdCampaignIds[0]);
      assert.ok(foundMulti, 'Should find created multi-step campaign in listing');
      assert.strictEqual(foundMulti.stepsCount, 2);
      console.log('✅ TEST 7 PASSED: getBulkCampaigns correctly provides stepsCount');
    }

    console.log('\n🎉 ALL 7 BULK EMAIL SEQUENCE TESTS PASSED PERFECTLY!\n');
  } catch (error) {
    console.error('❌ Test failed with error:', error);
    process.exitCode = 1;
  } finally {
    // Cleanup created test records
    for (const cId of createdCampaignIds) {
      await prisma.enrollment.deleteMany({ where: { campaignId: cId } }).catch(() => {});
      await prisma.sequenceStep.deleteMany({ where: { sequence: { campaignId: cId } } }).catch(() => {});
      await prisma.sequence.deleteMany({ where: { campaignId: cId } }).catch(() => {});
      await prisma.campaign.delete({ where: { id: cId } }).catch(() => {});
    }
    if (testContact) {
      await prisma.listMember.deleteMany({ where: { contactId: testContact.id } }).catch(() => {});
      await prisma.contactEmail.deleteMany({ where: { contactId: testContact.id } }).catch(() => {});
      await prisma.contact.delete({ where: { id: testContact.id } }).catch(() => {});
    }
    if (testList) {
      await prisma.list.delete({ where: { id: testList.id } }).catch(() => {});
    }
    if (testMailbox) {
      await prisma.mailbox.delete({ where: { id: testMailbox.id } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

runTests();
