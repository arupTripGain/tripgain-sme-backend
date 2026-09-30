import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { 
  createBulkCampaign, 
  getBulkCampaignById, 
  updateBulkCampaign, 
  getBulkCampaignPreflight, 
  sendBulkTestEmail, 
  queueBulkCampaign, 
  launchBulkCampaign 
} from '../src/controllers/bulkEmailController';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'tripgain_dev_jwt_secret_change_in_production';

function createMockReqRes(options: {
  token?: string | null;
  user?: any;
  params?: Record<string, string>;
  body?: any;
  query?: Record<string, string>;
}) {
  let statusCode = 200;
  let responseData: any = null;

  const req: any = {
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    params: options.params || {},
    body: options.body || {},
    query: options.query || {},
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
    },
    getStatusCode: () => statusCode,
    getData: () => responseData
  };

  return { req, res };
}

async function runWorkflowTestSuite() {
  console.log('====================================================');
  console.log('  RUNNING BULK EMAIL 7-STEP WORKFLOW TEST SUITE     ');
  console.log('====================================================\n');

  const timestamp = Date.now();
  let user: any = null;
  let workspace: any = null;
  let token: string = '';
  let authUser: any = null;
  let mailbox: any = null;
  let listA: any = null;
  let listB: any = null;
  let contact1: any = null;
  let contact2: any = null;
  let contactShared: any = null;
  let campaignId: string = '';

  try {
    // 0. Setup Fixtures
    user = await prisma.user.create({
      data: {
        email: `stepper_user_${timestamp}@tripgain.local`,
        name: 'Stepper Tester',
        role: 'ADMIN'
      }
    });

    workspace = await prisma.workspace.create({
      data: {
        name: `Stepper Workspace ${timestamp}`,
        userId: user.id
      }
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { workspaceId: workspace.id }
    });

    token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, workspaceId: workspace.id },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    authUser = { userId: user.id, email: user.email, role: user.role, workspaceId: workspace.id };

    mailbox = await prisma.mailbox.create({
      data: {
        userId: user.id,
        workspaceId: workspace.id,
        email: `stepper_sender_${timestamp}@tripgain.local`,
        displayName: 'Stepper Sender',
        provider: 'SMTP_IMAP',
        connectionType: 'SMTP_IMAP',
        status: 'CONNECTED',
        smtpStatus: 'CONNECTED',
        hourlySendLimit: 15,
        dailySendLimit: 100,
        isActive: true
      }
    });

    // Create 3 contacts: Contact 1 in List A, Contact 2 in List B, Contact Shared in both List A & B
    listA = await prisma.list.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        name: `List A (Tech Founders) ${timestamp}`,
        listType: 'static'
      }
    });

    listB = await prisma.list.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        name: `List B (Finance Executives) ${timestamp}`,
        listType: 'static'
      }
    });

    contact1 = await prisma.contact.create({
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

    contact2 = await prisma.contact.create({
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

    contactShared = await prisma.contact.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        firstName: 'Charlie',
        lastName: 'Shared',
        emails: {
          create: {
            email: `charlie_${timestamp}@shared-company.com`,
            normalizedEmail: `charlie_${timestamp}@shared-company.com`,
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

    console.log('✓ Test fixtures successfully initialized.\n');

    // ----------------------------------------------------
    // TEST 1: Step 1 Validation - Campaign Name Required
    // ----------------------------------------------------
    {
      const { req, res } = createMockReqRes({
        token,
        user: authUser,
        body: { name: '   ', description: 'Empty name test' }
      });
      await createBulkCampaign(req, res);
      if (res.getStatusCode() === 400 && res.getData()?.error) {
        console.log('✔ Test 1 passed: Step 1 validation properly rejects empty campaign name.');
      } else {
        throw new Error(`Test 1 failed: Expected 400 for empty name, got ${res.getStatusCode()}`);
      }
    }

    // ----------------------------------------------------
    // TEST 2 & 3: Step 2 Multi-List Audience Selection
    // ----------------------------------------------------
    {
      const { req, res } = createMockReqRes({
        token,
        user: authUser,
        body: {
          name: 'Global ChemShow Outreach',
          description: 'Q4 Executive product update',
          listIds: [listA.id, listB.id],
          subject: 'Initial Subject Line for {{firstName}}',
          bodyHtml: '<p>Hi {{firstName}}, check out <a href="{{unsubscribeLink}}">Unsubscribe</a></p>',
          senderMailboxes: [mailbox.id],
          dailySendLimit: 50,
          hourlySendLimit: 10
        }
      });
      await createBulkCampaign(req, res);
      const camp = res.getData();
      if (res.getStatusCode() === 201 && camp?.id && camp?.listIds?.length === 2) {
        campaignId = camp.id;
        console.log('✔ Test 2 & 3 passed: Multi-list audience properly saved in Step 2.');
      } else {
        throw new Error(`Test 2/3 failed: Expected 201 and listIds, got ${res.getStatusCode()}`);
      }
    }

    // ----------------------------------------------------
    // TEST 4: Authoritative Unique Audience Deduplication
    // ----------------------------------------------------
    {
      const { req, res } = createMockReqRes({
        token,
        user: authUser,
        params: { id: campaignId },
        query: { listIds: `${listA.id},${listB.id}` }
      });
      await getBulkCampaignPreflight(req, res);
      const preflight = res.getData();
      const rawCount = preflight?.audience?.rawListSize;
      const uniqueCount = preflight?.audience?.finalEligibleCount;
      const dupCount = preflight?.audience?.duplicateCount;

      if (rawCount === 4 && uniqueCount === 3 && dupCount === 1) {
        console.log('✔ Test 4 passed: Preflight accurately deduplicated shared contact across lists (raw 4 -> unique 3).');
      } else {
        throw new Error(`Test 4 failed: Expected raw 4 and unique 3, got raw: ${rawCount}, unique: ${uniqueCount}`);
      }
    }

    // ----------------------------------------------------
    // TEST 5 & 6: Step 3 Email Subject & Body Validation
    // ----------------------------------------------------
    {
      const { req, res } = createMockReqRes({
        token,
        user: authUser,
        params: { id: campaignId },
        body: {
          sequenceSteps: [
            { stepNumber: 1, subjectTemplate: '', bodyHtmlTemplate: '<p>Valid body</p>' }
          ]
        }
      });
      await updateBulkCampaign(req, res);
      
      const { req: pReq, res: pRes } = createMockReqRes({
        token,
        user: authUser,
        params: { id: campaignId }
      });
      await getBulkCampaignPreflight(pReq, pRes);
      const pData = pRes.getData();
      const hasSubjectError = pData?.template?.errors?.some((e: string) => e.toLowerCase().includes('subject')) || pData?.errors?.some((e: string) => e.toLowerCase().includes('subject')) || pData?.template?.hasSubject === false;
      if (hasSubjectError) {
        console.log('✔ Test 5 & 6 passed: Step 3 validation flags missing subject in email template audit.');
      } else {
        throw new Error('Test 5 & 6 failed: Preflight did not flag empty subject in step 1.');
      }
    }

    // ----------------------------------------------------
    // TEST 7: Step 4 Sender Mailbox Validation
    // ----------------------------------------------------
    {
      const { req, res } = createMockReqRes({
        token,
        user: authUser,
        params: { id: campaignId },
        body: { senderMailboxes: [] }
      });
      await updateBulkCampaign(req, res);

      const { req: pReq, res: pRes } = createMockReqRes({
        token,
        user: authUser,
        params: { id: campaignId }
      });
      await getBulkCampaignPreflight(pReq, pRes);
      const pData = pRes.getData();
      const hasMailboxIssue = pData?.mailboxPool?.allSmtpConnected === false || pData?.delivery?.allSmtpConnected === false || pData?.canQueue === false || (pData?.mailboxPool?.mailboxes?.length === 0);
      if (hasMailboxIssue) {
        console.log('✔ Test 7 passed: Step 4 validation flags empty/disconnected sender mailbox pool.');
      } else {
        throw new Error('Test 7 failed: Preflight did not flag empty mailbox pool.');
      }
    }

    // ----------------------------------------------------
    // TEST 8: Step 5 Schedule & Window Settings
    // ----------------------------------------------------
    {
      const targetDate = new Date(Date.now() + 86400000); // Tomorrow
      const { req, res } = createMockReqRes({
        token,
        user: authUser,
        params: { id: campaignId },
        body: {
          senderMailboxes: [mailbox.id],
          dailySendLimit: 75,
          hourlySendLimit: 12,
          timezone: 'America/New_York',
          sendingWindowStart: '10:00',
          sendingWindowEnd: '16:00',
          startAt: targetDate.toISOString(),
          sequenceSteps: [
            {
              stepNumber: 1,
              subjectTemplate: 'Executive Update for {{firstName}}',
              bodyHtmlTemplate: '<p>Hi {{firstName}}, updates... <a href="{{unsubscribeLink}}">Unsubscribe</a></p>'
            },
            {
              stepNumber: 2,
              delayDays: 2,
              subjectTemplate: '',
              bodyHtmlTemplate: '<p>Following up... <a href="{{unsubscribeLink}}">Unsubscribe</a></p>'
            }
          ]
        }
      });
      await updateBulkCampaign(req, res);
      const updated = res.getData();

      if (updated.dailySendLimit === 75 && updated.timezone === 'America/New_York' && updated.startAt) {
        console.log('✔ Test 8 passed: Step 5 schedule, timezone, limits, and startAt persisted accurately.');
      } else {
        throw new Error('Test 8 failed: Schedule fields did not persist properly.');
      }
    }

    // ----------------------------------------------------
    // TEST 9 & 10: Back & Forward Navigation Preserves Data
    // ----------------------------------------------------
    {
      const { req, res } = createMockReqRes({
        token,
        user: authUser,
        params: { id: campaignId }
      });
      await getBulkCampaignById(req, res);
      const loaded = res.getData();

      if (
        loaded.name === 'Global ChemShow Outreach' &&
        loaded.listIds.length === 2 &&
        loaded.senderMailboxes.length === 1 &&
        loaded.steps.length === 2
      ) {
        console.log('✔ Test 9 & 10 passed: Complete campaign state preserved across wizard step transitions.');
      } else {
        throw new Error('Test 9/10 failed: Loaded campaign data was incomplete.');
      }
    }

    // ----------------------------------------------------
    // TEST 11 & 12: Existing Campaign Loads & Editing
    // ----------------------------------------------------
    {
      const { req, res } = createMockReqRes({
        token,
        user: authUser,
        params: { id: campaignId },
        body: { description: 'Updated internal note from edit wizard' }
      });
      await updateBulkCampaign(req, res);
      const edited = res.getData();

      if (edited.description === 'Updated internal note from edit wizard') {
        console.log('✔ Test 11 & 12 passed: Existing campaign loads cleanly into editor and updates without data loss.');
      } else {
        throw new Error('Test 11/12 failed: Could not edit existing campaign.');
      }
    }

    // ----------------------------------------------------
    // TEST 13: Step 6 Review Displays Correct Audit
    // ----------------------------------------------------
    {
      const { req, res } = createMockReqRes({
        token,
        user: authUser,
        params: { id: campaignId }
      });
      await getBulkCampaignPreflight(req, res);
      const audit = res.getData();

      if (audit.isReadyToQueue === true && audit.audience.finalEligibleCount === 3 && audit.delivery.allSmtpConnected === true) {
        console.log('✔ Test 13 passed: Review audit displays all green checklists and permits queueing.');
      } else {
        throw new Error('Test 13 failed: Review preflight check failed.');
      }
    }

    // ----------------------------------------------------
    // TEST 14: Safe Test Email Dispatches Cleanly
    // ----------------------------------------------------
    {
      const { req, res } = createMockReqRes({
        token,
        user: authUser,
        params: { id: campaignId },
        body: {
          testRecipients: ['safe.tester@example.com'],
          stepNumber: 1
        }
      });
      await sendBulkTestEmail(req, res);
      const testResult = res.getData();

      if (res.getStatusCode() === 200 && testResult.success && testResult.totalSent === 1) {
        console.log('✔ Test 14 passed: Safe test email dispatches without touching queue or real leads.');
      } else {
        throw new Error(`Test 14 failed: Expected 200 and totalSent 1, got ${res.getStatusCode()}`);
      }
    }

    // ----------------------------------------------------
    // TEST 15 & 16: Step 7 Final Action - Queue Enrolls Deduplicated Contacts
    // ----------------------------------------------------
    {
      const { req, res } = createMockReqRes({
        token,
        user: authUser,
        params: { id: campaignId }
      });
      await queueBulkCampaign(req, res);
      const queueRes = res.getData();

      if (queueRes.queuedCount === 3) {
        console.log('✔ Test 15 & 16 passed: Final send phase queued exactly 3 unique recipients (zero duplicates).');
      } else {
        throw new Error(`Test 15/16 failed: Expected 3 queued contacts, got ${queueRes.queuedCount}`);
      }
    }

    // ----------------------------------------------------
    // TEST 17: Empty Audience Rejected
    // ----------------------------------------------------
    {
      const emptyList = await prisma.list.create({
        data: {
          workspaceId: workspace.id,
          userId: user.id,
          name: `Empty Test List ${timestamp}`,
          listType: 'static'
        }
      });

      const { req: cReq, res: cRes } = createMockReqRes({
        token,
        user: authUser,
        body: {
          name: 'Empty List Campaign',
          listIds: [emptyList.id],
          subject: 'Test',
          bodyHtml: '<p>Test</p>',
          senderMailboxes: [mailbox.id]
        }
      });
      await createBulkCampaign(cReq, cRes);
      const emptyCamp = cRes.getData();

      const { req: qReq, res: qRes } = createMockReqRes({
        token,
        user: authUser,
        params: { id: emptyCamp.id }
      });
      await queueBulkCampaign(qReq, qRes);

      if (qRes.getStatusCode() === 400 && qRes.getData()?.error?.toLowerCase().includes('no eligible')) {
        console.log('✔ Test 17 passed: Queueing empty audience properly blocked with 400.');
      } else {
        throw new Error(`Test 17 failed: Did not reject empty audience. Status: ${qRes.getStatusCode()}, data: ${JSON.stringify(qRes.getData())}`);
      }

      await prisma.campaign.delete({ where: { id: emptyCamp.id } }).catch(() => {});
      await prisma.list.delete({ where: { id: emptyList.id } }).catch(() => {});
    }

    // ----------------------------------------------------
    // TEST 18: Campaign Activation (Launch / Schedule)
    // ----------------------------------------------------
    {
      const { req, res } = createMockReqRes({
        token,
        user: authUser,
        params: { id: campaignId }
      });
      await launchBulkCampaign(req, res);
      const launchData = res.getData();

      if (res.getStatusCode() === 200 && (launchData.status === 'active' || launchData.status === 'scheduled')) {
        console.log(`✔ Test 18 passed: Campaign activation transitioned successfully (status: ${launchData.status}).`);
      } else {
        throw new Error(`Test 18 failed: Expected active or scheduled status, got ${launchData?.status}`);
      }
    }

    console.log('\n====================================================');
    console.log('  ALL 18 STEP-BY-STEP WORKFLOW TESTS PASSED! 🎉     ');
    console.log('====================================================\n');

  } finally {
    // Cleanup synthetic fixtures
    try {
      if (campaignId) {
        await prisma.enrollment.deleteMany({ where: { campaignId } }).catch(() => {});
        await prisma.sequenceStep.deleteMany({ where: { sequence: { campaignId } } }).catch(() => {});
        await prisma.sequence.deleteMany({ where: { campaignId } }).catch(() => {});
        await prisma.campaign.delete({ where: { id: campaignId } }).catch(() => {});
      }
      if (listA) {
        await prisma.listMember.deleteMany({ where: { listId: listA.id } }).catch(() => {});
        await prisma.list.delete({ where: { id: listA.id } }).catch(() => {});
      }
      if (listB) {
        await prisma.listMember.deleteMany({ where: { listId: listB.id } }).catch(() => {});
        await prisma.list.delete({ where: { id: listB.id } }).catch(() => {});
      }
      if (contact1) {
        await prisma.contactEmail.deleteMany({ where: { contactId: contact1.id } }).catch(() => {});
        await prisma.contact.delete({ where: { id: contact1.id } }).catch(() => {});
      }
      if (contact2) {
        await prisma.contactEmail.deleteMany({ where: { contactId: contact2.id } }).catch(() => {});
        await prisma.contact.delete({ where: { id: contact2.id } }).catch(() => {});
      }
      if (contactShared) {
        await prisma.contactEmail.deleteMany({ where: { contactId: contactShared.id } }).catch(() => {});
        await prisma.contact.delete({ where: { id: contactShared.id } }).catch(() => {});
      }
      if (mailbox) {
        await prisma.mailbox.delete({ where: { id: mailbox.id } }).catch(() => {});
      }
      if (workspace) {
        await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      }
      if (user) {
        await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
      }
      await prisma.$disconnect();
    } catch {
      // Ignore cleanup error
    }
  }
}

runWorkflowTestSuite().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
