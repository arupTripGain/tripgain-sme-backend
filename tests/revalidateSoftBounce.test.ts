import 'dotenv/config';
import assert from 'assert';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { revalidateSoftBounceContact } from '../src/controllers/contactController';
import { updateEnrollmentStatus } from '../src/controllers/campaignController';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'tripgain_dev_jwt_secret_change_in_production';

function createMockResponse() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    }
  };
  return res;
}

async function runTests() {
  console.log('--- STARTING REVALIDATE SOFT BOUNCE TESTS ---');

  // Test setup: Synthetic test user and workspace
  const user = await prisma.user.create({
    data: {
      email: `test_recov_${Date.now()}@tripgain.com`,
      name: 'Recovery Test User'
    }
  });

  const workspace = await prisma.workspace.create({
    data: {
      name: 'Recovery Workspace',
      userId: user.id
    }
  });

  const token = jwt.sign({ userId: user.id, email: user.email, role: 'MEMBER' }, JWT_SECRET);
  const authHeaders = { authorization: `Bearer ${token}` };

  try {
    // 1. Requirement 1: Require intentional user action (confirm: true)
    const contact1 = await prisma.contact.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        firstName: 'Intentional',
        emails: {
          create: [{
            email: `intentional_${Date.now()}@example.com`,
            normalizedEmail: `intentional_${Date.now()}@example.com`,
            isPrimary: true,
            verificationStatus: 'soft_bounced'
          }]
        }
      }
    });

    const reqNoConfirm: any = {
      user: { userId: user.id, email: user.email },
      headers: authHeaders,
      params: { id: contact1.id },
      body: {} // Missing confirm: true
    };
    const resNoConfirm = createMockResponse();
    await revalidateSoftBounceContact(reqNoConfirm, resNoConfirm);
    assert.strictEqual(resNoConfirm.statusCode, 400, 'Must reject if confirm is not true');
    assert(resNoConfirm.body.error.includes('Intentional confirmation required'), 'Error must mention intentional confirmation');
    console.log('✔ Test 1 passed: Intentional user action required');

    // 2. Requirement 2: Authenticated and ownership protected
    const otherUser = await prisma.user.create({
      data: {
        email: `other_user_${Date.now()}@tripgain.com`,
        name: 'Other User'
      }
    });
    const reqWrongOwner: any = {
      user: { userId: otherUser.id, email: otherUser.email },
      headers: { authorization: `Bearer ${jwt.sign({ userId: otherUser.id, email: otherUser.email }, JWT_SECRET)}` },
      params: { id: contact1.id },
      body: { confirm: true }
    };
    const resWrongOwner = createMockResponse();
    await revalidateSoftBounceContact(reqWrongOwner, resWrongOwner);
    assert.strictEqual(resWrongOwner.statusCode, 404, 'Must reject access to non-owned contact');
    console.log('✔ Test 2 passed: Ownership protection enforced');

    // 3. Requirement 5: Never remove a hard-bounce suppression
    const hardSuppressedEmail = `hard_supp_${Date.now()}@example.com`;
    await prisma.suppressionList.create({
      data: {
        userId: user.id,
        email: hardSuppressedEmail,
        normalizedEmail: hardSuppressedEmail,
        reason: 'hard_bounce'
      }
    });

    const contactHardSuppressed = await prisma.contact.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        firstName: 'HardSuppressed',
        emails: {
          create: [{
            email: hardSuppressedEmail,
            normalizedEmail: hardSuppressedEmail,
            isPrimary: true,
            verificationStatus: 'soft_bounced'
          }]
        }
      }
    });

    const reqHardSupp: any = {
      user: { userId: user.id, email: user.email },
      headers: authHeaders,
      params: { id: contactHardSuppressed.id },
      body: { confirm: true }
    };
    const resHardSupp = createMockResponse();
    await revalidateSoftBounceContact(reqHardSupp, resHardSupp);
    assert.strictEqual(resHardSupp.statusCode, 403, 'Must reject re-validation for hard-suppressed email');
    assert(resHardSupp.body.error.includes('permanently suppressed'), 'Must state permanent suppression');
    console.log('✔ Test 3 passed: Hard-bounce suppression cannot be removed');

    // Also verify contact with verificationStatus = bounced is blocked
    const contactHardBounced = await prisma.contact.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        firstName: 'HardBounced',
        emails: {
          create: [{
            email: `bounced_${Date.now()}@example.com`,
            normalizedEmail: `bounced_${Date.now()}@example.com`,
            isPrimary: true,
            verificationStatus: 'bounced'
          }]
        }
      }
    });
    const reqHardBounced: any = {
      user: { userId: user.id, email: user.email },
      headers: authHeaders,
      params: { id: contactHardBounced.id },
      body: { confirm: true }
    };
    const resHardBounced = createMockResponse();
    await revalidateSoftBounceContact(reqHardBounced, resHardBounced);
    assert.strictEqual(resHardBounced.statusCode, 403, 'Must reject hard-bounced contact');
    console.log('✔ Test 4 passed: Direct hard-bounce contact verification rejected');

    // 4. Requirement 4 & 3: Clear soft-bounce block ONLY after successful revalidation & Audit log recorded
    const testValidEmail = `valid_recov_${Date.now()}@domain.com`;
    const contactToRecover = await prisma.contact.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        firstName: 'Recoverable',
        emails: {
          create: [{
            email: testValidEmail,
            normalizedEmail: testValidEmail,
            isPrimary: true,
            verificationStatus: 'soft_bounced'
          }]
        }
      }
    });

    const campaign = await prisma.campaign.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        name: 'Test Cam'
      }
    });

    const sequence = await prisma.sequence.create({
      data: {
        campaignId: campaign.id,
        name: 'Seq'
      }
    });

    const enrollment = await prisma.enrollment.create({
      data: {
        campaignId: campaign.id,
        sequenceId: sequence.id,
        contactId: contactToRecover.id,
        status: 'soft_bounced',
        stopReason: 'SOFT_BOUNCE'
      }
    });

    // Test that manual resume of soft_bounced enrollment is blocked
    const reqResumeEnr: any = {
      user: { userId: user.id, email: user.email },
      headers: authHeaders,
      params: { id: campaign.id, enrollmentId: enrollment.id },
      body: { action: 'resume' }
    };
    const resResumeEnr = createMockResponse();
    await updateEnrollmentStatus(reqResumeEnr, resResumeEnr);
    assert.strictEqual(resResumeEnr.statusCode, 400, 'Cannot resume soft-bounced enrollment directly');
    console.log('✔ Test 5 passed: Direct manual enrollment resume blocked for soft_bounced status');

    // Now execute explicit "Re-validate & Allow Sending"
    const reqRevalidate: any = {
      user: { userId: user.id, email: user.email },
      headers: authHeaders,
      params: { id: contactToRecover.id },
      body: { confirm: true }
    };
    const resRevalidate = createMockResponse();
    await revalidateSoftBounceContact(reqRevalidate, resRevalidate);
    assert.strictEqual(resRevalidate.statusCode, 200, 'Re-validation must succeed for valid soft-bounced contact');
    assert.strictEqual(resRevalidate.body.verificationStatus, 'valid');

    // Verify DB state updated
    const updatedEmail = await prisma.contactEmail.findFirst({
      where: { contactId: contactToRecover.id }
    });
    assert.strictEqual(updatedEmail?.verificationStatus, 'valid', 'ContactEmail status must now be valid');

    // Verify Enrollment state in Campaign A remains soft_bounced (truthful historical delivery record)
    const historicalEnrollment = await prisma.enrollment.findUnique({
      where: { id: enrollment.id }
    });
    assert.strictEqual(historicalEnrollment?.status, 'soft_bounced', 'Historical enrollment MUST remain soft_bounced');
    assert.strictEqual(historicalEnrollment?.stopReason, 'SOFT_BOUNCE', 'Historical stopReason must remain SOFT_BOUNCE');

    // Verify future Campaign B can enroll and is NOT blocked by past soft_bounced enrollment
    const campaignB = await prisma.campaign.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        name: 'Future Campaign B'
      }
    });
    const seqB = await prisma.sequence.create({
      data: {
        campaignId: campaignB.id,
        name: 'Seq B'
      }
    });
    const enrollmentB = await prisma.enrollment.create({
      data: {
        campaignId: campaignB.id,
        sequenceId: seqB.id,
        contactId: contactToRecover.id,
        status: 'pending'
      }
    });

    // Verify contact's current verification status allows sending in future Campaign B
    const contactForScheduler = await prisma.contact.findUnique({
      where: { id: contactToRecover.id },
      include: { emails: true }
    });
    const hasSoftBounceState = contactForScheduler?.emails?.some(e => e.verificationStatus === 'soft_bounced');
    assert.strictEqual(hasSoftBounceState, false, 'Future Campaign B must NOT be blocked by historical soft bounce');

    // Verify ActivityLog created
    const activityLog = await prisma.activityLog.findFirst({
      where: {
        workspaceId: workspace.id,
        action: 'contact_soft_bounce_revalidated',
        entityId: contactToRecover.id
      }
    });
    assert(activityLog !== null, 'ActivityLog entry must be created');
    assert(activityLog.description?.includes(testValidEmail), 'ActivityLog description must reference email');
    console.log('✔ Test 6 passed: Soft-bounce cleared on ContactEmail, historical Campaign A enrollment preserved as soft_bounced, future Campaign B eligible, and audit activity logged');

    console.log('--- ALL REVALIDATE SOFT BOUNCE TESTS PASSED ---');
  } finally {
    // Cleanup synthetic test records
    await prisma.activityLog.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.enrollment.deleteMany({ where: { contact: { workspaceId: workspace.id } } });
    await prisma.sequence.deleteMany({ where: { campaign: { workspaceId: workspace.id } } });
    await prisma.campaign.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.contactEmail.deleteMany({ where: { contact: { workspaceId: workspace.id } } });
    await prisma.suppressionList.deleteMany({ where: { userId: user.id } });
    await prisma.contact.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.user.deleteMany({ where: { email: { startsWith: 'other_user_' } } });
    await prisma.$disconnect();
  }
}

runTests().catch((err) => {
  console.error('Test run error:', err);
  process.exit(1);
});
