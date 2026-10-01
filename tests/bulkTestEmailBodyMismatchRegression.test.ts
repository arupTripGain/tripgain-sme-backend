import 'dotenv/config';
import assert from 'assert';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { sendBulkTestEmail } from '../src/controllers/bulkEmailController';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'tripgain_dev_jwt_secret_change_in_production';

function createMockReqRes(options: {
  token?: string | null;
  user?: any;
  params?: Record<string, string>;
  body?: any;
}) {
  let statusCode = 200;
  let responseData: any = null;

  const req: any = {
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    params: options.params || {},
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
    get statusCode() {
      return statusCode;
    },
    get data() {
      return responseData;
    }
  };

  return { req, res };
}

async function runRegressionTest() {
  console.log('🧪 RUNNING REGRESSION TEST: Bulk Email Test Email Body Integrity\n');

  let testUser: any = null;
  let testWorkspace: any = null;
  let testMailbox: any = null;
  let testContact: any = null;
  let testCampaign: any = null;

  try {
    const uniqueSuffix = Date.now().toString().slice(-6);

    testUser = await prisma.user.create({
      data: {
        email: `tester_bulk_${uniqueSuffix}@tripgain.local`,
        name: 'Arup Nirala',
        role: 'ADMIN'
      }
    });

    testWorkspace = await prisma.workspace.create({
      data: {
        name: `Regression Workspace ${uniqueSuffix}`,
        userId: testUser.id
      }
    });

    testMailbox = await prisma.mailbox.create({
      data: {
        userId: testUser.id,
        workspaceId: testWorkspace.id,
        email: `sender_${uniqueSuffix}@tripgain.local`,
        displayName: 'Arup Nirala',
        provider: 'SMTP_IMAP',
        connectionType: 'SMTP_IMAP',
        status: 'CONNECTED',
        isActive: true
      }
    });

    const contactEmail = `vikram_${uniqueSuffix}@example.com`;
    testContact = await prisma.contact.create({
      data: {
        workspaceId: testWorkspace.id,
        userId: testUser.id,
        firstName: 'Vikram',
        lastName: 'Sharma',
        fullName: 'Vikram Sharma',
        emails: {
          create: [{
            email: contactEmail,
            normalizedEmail: contactEmail.toLowerCase(),
            isPrimary: true
          }]
        }
      }
    });

    // Create a bulk campaign where the database sequence step intentionally starts with the stale follow-up text
    testCampaign = await prisma.campaign.create({
      data: {
        workspaceId: testWorkspace.id,
        userId: testUser.id,
        name: `Bharat Tex Outreach ${uniqueSuffix}`,
        campaignType: 'BULK_EMAIL',
        senderMailboxes: [testMailbox.id],
        sequences: {
          create: {
            name: 'Primary Sequence',
            sequenceType: 'BULK_EMAIL',
            steps: {
              create: [
                {
                  stepNumber: 1,
                  stepName: 'Initial Send',
                  delayDays: 0,
                  subjectTemplate: 'Stale Subject Note',
                  bodyTemplate: '<p>Hi {{firstName}},</p><p>Following up on my previous note. Let me know if you would like to connect this week.</p>',
                  bodyHtmlTemplate: '<p>Hi {{firstName}},</p><p>Following up on my previous note. Let me know if you would like to connect this week.</p>'
                }
              ]
            }
          }
        }
      }
    });

    const token = jwt.sign(
      { userId: testUser.id, email: testUser.email, role: 'ADMIN' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    const authUser = { userId: testUser.id, email: testUser.email, role: 'ADMIN' };

    // ==================================================
    // TEST CASE 1: Explicit Body in sendBulkTestEmail (Editor Body Pass-Through)
    // ==================================================
    console.log('--- TEST CASE 1: Explicit Editor Body in Payload ---');
    const editorBody = '<p>Hi {{firstName}},</p><p>I noticed your company was listed as an exhibitor at Bharat Tex 2026. TEST_BULK_BODY_2026_UNIQUE</p>';
    const editorSubject = 'Question for {{firstName}}';

    const { req, res } = createMockReqRes({
      token,
      user: authUser,
      params: { id: testCampaign.id },
      body: {
        testRecipients: ['synthetic.tester@example.com'],
        sampleContactId: testContact.id,
        stepNumber: 1,
        subject: editorSubject,
        body: editorBody
      }
    });

    await sendBulkTestEmail(req, res);
    assert.strictEqual(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${JSON.stringify(res.data)}`);

    const result = res.data;
    assert.ok(result.success, 'Dispatch must report success');
    assert.strictEqual(result.renderedSubject, '[TEST] Question for Vikram', 'Subject must personalize {{firstName}} to Vikram');

    const resultItem = result.results?.[0];
    if (!resultItem || !resultItem.renderedBody) throw new Error('Must return renderedBody');

    // Assert that the email contains the unique token
    assert.ok(
      resultItem.renderedBody.includes('TEST_BULK_BODY_2026_UNIQUE'),
      'Rendered email body MUST contain TEST_BULK_BODY_2026_UNIQUE'
    );

    // Assert that the email personalizes {{firstName}} to Vikram
    assert.ok(
      resultItem.renderedBody.includes('Hi Vikram'),
      'Rendered email body MUST personalize {{firstName}} to Vikram'
    );

    // Assert that the email does NOT contain the stale follow-up text
    assert.ok(
      !resultItem.renderedBody.includes('Following up on my previous note'),
      'Rendered email body MUST NOT contain "Following up on my previous note"'
    );
    assert.ok(
      !resultItem.renderedBody.includes('Let me know if you would like to connect this week'),
      'Rendered email body MUST NOT contain "Let me know if you would like to connect this week"'
    );

    console.log('✅ TEST CASE 1 PASSED: Explicit editor body is correctly rendered with personalization Vikram, TEST_BULK_BODY_2026_UNIQUE present, and stale follow-up text absent.');

    // ==================================================
    // TEST CASE 2: Draft Saved to DB, Test Sent with Saved Draft Content
    // ==================================================
    console.log('\n--- TEST CASE 2: Saved Draft in Database Content ---');
    // Update step 1 in DB with new unique body
    const seq = await prisma.sequence.findFirst({
      where: { campaignId: testCampaign.id },
      include: { steps: true }
    });
    if (!seq || !seq.steps || seq.steps.length === 0) throw new Error('Missing seq or steps');
    const firstStep = seq.steps[0];
    if (!firstStep) throw new Error('Missing first step');

    await prisma.sequenceStep.update({
      where: { id: firstStep.id },
      data: {
        subjectTemplate: 'Saved Subject for {{firstName}}',
        bodyTemplate: '<p>Hi {{firstName}}, Saved draft content TEST_BULK_BODY_2026_UNIQUE</p>',
        bodyHtmlTemplate: '<p>Hi {{firstName}}, Saved draft content TEST_BULK_BODY_2026_UNIQUE</p>'
      }
    });

    const { req: req2, res: res2 } = createMockReqRes({
      token,
      user: authUser,
      params: { id: testCampaign.id },
      body: {
        testRecipients: ['synthetic.tester@example.com'],
        sampleContactId: testContact.id,
        stepNumber: 1
        // No explicit body, reading from DB step
      }
    });

    await sendBulkTestEmail(req2, res2);
    assert.strictEqual(res2.statusCode, 200);

    const result2 = res2.data;
    assert.strictEqual(result2.renderedSubject, '[TEST] Saved Subject for Vikram');
    const resultItem2 = result2.results?.[0];
    if (!resultItem2 || !resultItem2.renderedBody) throw new Error('Missing resultItem2 or renderedBody');
    assert.ok(resultItem2.renderedBody.includes('TEST_BULK_BODY_2026_UNIQUE'));
    assert.ok(resultItem2.renderedBody.includes('Hi Vikram'));
    assert.ok(!resultItem2.renderedBody.includes('Following up on my previous note'));

    console.log('✅ TEST CASE 2 PASSED: DB step content is correctly rendered when explicit body is omitted.');

    console.log('\n🎉 ALL REGRESSION TESTS PASSED! Test email body mismatch bug is resolved.\n');
  } catch (err) {
    console.error('❌ Regression test failed:', err);
    process.exitCode = 1;
  } finally {
    if (testCampaign) {
      await prisma.sequenceStep.deleteMany({ where: { sequence: { campaignId: testCampaign.id } } }).catch(() => {});
      await prisma.sequence.deleteMany({ where: { campaignId: testCampaign.id } }).catch(() => {});
      await prisma.campaign.delete({ where: { id: testCampaign.id } }).catch(() => {});
    }
    if (testContact) {
      await prisma.contactEmail.deleteMany({ where: { contactId: testContact.id } }).catch(() => {});
      await prisma.contact.delete({ where: { id: testContact.id } }).catch(() => {});
    }
    if (testMailbox) {
      await prisma.mailbox.delete({ where: { id: testMailbox.id } }).catch(() => {});
    }
    if (testWorkspace) {
      await prisma.workspace.delete({ where: { id: testWorkspace.id } }).catch(() => {});
    }
    if (testUser) {
      await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

runRegressionTest();
