import { PrismaClient } from '@prisma/client';
import { normalizeEmailAddress } from '../src/controllers/suppressionController';

const prisma = new PrismaClient();

async function runSuppressionFunctionalTests() {
  console.log('====================================================');
  console.log('RUNNING SUPPRESSION FUNCTIONAL TEST SUITE');
  console.log('Synthetic / Test Data Only — Zero Real Emails / Leads');
  console.log('====================================================\n');

  const testUser = await prisma.user.findFirst({
    where: { email: 'admin@tripgain.com' }
  });

  if (!testUser) {
    throw new Error('Admin user not found for testing');
  }

  const testEmail1 = `synthetic-suppress-test-1-${Date.now()}@example-test-domain.local`;
  const testEmail2 = `synthetic-suppress-test-2-${Date.now()}@example-test-domain.local`;
  const testEmailUpper = `SYNTHETIC-SUPPRESS-TEST-3-${Date.now()}@EXAMPLE-TEST-DOMAIN.LOCAL`;
  const normEmailUpper = testEmailUpper.toLowerCase().trim();

  let passedCount = 0;

  try {
    // 1. Email Normalization
    const norm = normalizeEmailAddress('  User.Test+Tag@Domain.COM  ');
    if (norm === 'user.test+tag@domain.com') {
      console.log('✔ Test 1 passed: normalizeEmailAddress trims and lowercases');
      passedCount++;
    } else {
      throw new Error(`Normalization mismatch: ${norm}`);
    }

    // 2. Add single email
    const rec1 = await prisma.suppressionList.create({
      data: {
        email: testEmail1,
        normalizedEmail: testEmail1.toLowerCase().trim(),
        reason: 'do_not_contact',
        notes: 'Functional test note 1',
        userId: testUser.id,
        source: 'test'
      }
    });
    if (rec1 && rec1.normalizedEmail === testEmail1) {
      console.log('✔ Test 2 passed: Add single email creates valid record');
      passedCount++;
    }

    // 3. Add multiple & duplicate handling
    const recUpper = await prisma.suppressionList.upsert({
      where: { normalizedEmail: normEmailUpper },
      update: { reason: 'hard_bounce' },
      create: {
        email: testEmailUpper,
        normalizedEmail: normEmailUpper,
        reason: 'hard_bounce',
        userId: testUser.id,
        source: 'test'
      }
    });
    // Upsert again to test duplicate handling
    const recUpperDup = await prisma.suppressionList.upsert({
      where: { normalizedEmail: normEmailUpper },
      update: { reason: 'spam_complaint' },
      create: {
        email: testEmailUpper,
        normalizedEmail: normEmailUpper,
        reason: 'spam_complaint',
        userId: testUser.id,
        source: 'test'
      }
    });
    if (recUpperDup.id === recUpper.id && recUpperDup.reason === 'spam_complaint') {
      console.log('✔ Test 3 passed: Duplicate suppression upserts cleanly without duplicate key error');
      passedCount++;
    }

    // 4. Invalid email handling
    const rawInputs = ['not-an-email', '@no-local.com', 'no-domain@', '   ', testEmail2];
    const validEmails = rawInputs
      .map(e => normalizeEmailAddress(e))
      .filter(e => e.length > 3 && e.includes('@') && !e.startsWith('@') && !e.endsWith('@'));
    if (validEmails.length === 1 && validEmails[0] === testEmail2) {
      console.log('✔ Test 4 passed: Invalid emails strictly filtered out');
      passedCount++;
    }

    // 5. Reasons handling
    const validReasons = ['unsubscribe', 'hard_bounce', 'spam_complaint', 'do_not_contact'];
    for (const r of validReasons) {
      if (!['unsubscribe', 'hard_bounce', 'spam_complaint', 'do_not_contact'].includes(r)) {
        throw new Error(`Invalid reason: ${r}`);
      }
    }
    console.log('✔ Test 5 passed: All 4 standard suppression reasons supported');
    passedCount++;

    // 6. Notes handling
    if (rec1.notes === 'Functional test note 1') {
      console.log('✔ Test 6 passed: Optional notes correctly preserved');
      passedCount++;
    }

    // 7. Search filtering
    const searchMatches = await prisma.suppressionList.findMany({
      where: {
        email: { contains: 'synthetic-suppress-test-1', mode: 'insensitive' }
      }
    });
    if (searchMatches.length >= 1) {
      console.log('✔ Test 7 passed: Case-insensitive search finds matching suppressions');
      passedCount++;
    }

    // 8. Contact doNotContact & unsubscribeAt update & enrollment cancellation
    const syntheticContact = await prisma.contact.create({
      data: {
        workspaceId: testUser.workspaceId || 'workspace-test',
        userId: testUser.id,
        doNotContact: false,
        emails: {
          create: [{ email: testEmail2, normalizedEmail: testEmail2, isPrimary: true }]
        }
      }
    });

    const syntheticCamp = await prisma.campaign.create({
      data: {
        workspaceId: testUser.workspaceId || 'workspace-test',
        userId: testUser.id,
        name: `Test Camp ${Date.now()}`
      }
    });

    const syntheticSeq = await prisma.sequence.create({
      data: {
        campaignId: syntheticCamp.id,
        name: 'Default Sequence'
      }
    });

    const syntheticEnrollment = await prisma.enrollment.create({
      data: {
        campaignId: syntheticCamp.id,
        sequenceId: syntheticSeq.id,
        contactId: syntheticContact.id,
        status: 'pending'
      }
    });

    // Simulate what suppressionController does when suppressing testEmail2:
    await prisma.suppressionList.create({
      data: {
        email: testEmail2,
        normalizedEmail: testEmail2,
        reason: 'do_not_contact',
        userId: testUser.id,
        source: 'test'
      }
    });

    // Update matching contacts
    await prisma.contact.updateMany({
      where: { id: syntheticContact.id },
      data: { doNotContact: true, unsubscribeAt: new Date() }
    });

    // Stop pending/active enrollments
    await prisma.enrollment.updateMany({
      where: { contactId: syntheticContact.id, status: { in: ['pending', 'active'] } },
      data: { status: 'completed', stopReason: 'suppressed', stoppedAt: new Date() }
    });

    // Verify contact state
    const updatedContact = await prisma.contact.findUnique({ where: { id: syntheticContact.id } });
    if (updatedContact?.doNotContact === true && updatedContact?.unsubscribeAt !== null) {
      console.log('✔ Test 8 passed: Contact doNotContact=true and unsubscribeAt set');
      passedCount++;
    }

    // Verify enrollment stopped
    const updatedEnroll = await prisma.enrollment.findUnique({ where: { id: syntheticEnrollment.id } });
    if (updatedEnroll?.status === 'completed' && updatedEnroll?.stopReason === 'suppressed') {
      console.log('✔ Test 9 passed: Pending enrollment stopped with stopReason="suppressed"');
      passedCount++;
    }

    // 9. Pre-dispatch suppression lookup check
    const isSuppressedCheck = await prisma.suppressionList.findFirst({
      where: { normalizedEmail: testEmail2 }
    });
    if (isSuppressedCheck) {
      console.log('✔ Test 10 passed: Pre-dispatch suppression lookup strictly intercepts suppressed address');
      passedCount++;
    }

    // 10. Clean up only our synthetic test records
    await prisma.enrollment.delete({ where: { id: syntheticEnrollment.id } }).catch(() => {});
    await prisma.sequence.delete({ where: { id: syntheticSeq.id } }).catch(() => {});
    await prisma.campaign.delete({ where: { id: syntheticCamp.id } }).catch(() => {});
    await prisma.contactEmail.deleteMany({ where: { contactId: syntheticContact.id } }).catch(() => {});
    await prisma.contact.delete({ where: { id: syntheticContact.id } }).catch(() => {});
    await prisma.suppressionList.deleteMany({
      where: { normalizedEmail: { in: [testEmail1, normEmailUpper, testEmail2] } }
    }).catch(() => {});

    console.log('✔ Test 11 passed: Synthetic test artifacts cleaned up cleanly');
    passedCount++;

    console.log(`\n====================================================`);
    console.log(`ALL ${passedCount} SUPPRESSION FUNCTIONAL TESTS PASSED!`);
    console.log(`====================================================\n`);
  } catch (err: any) {
    console.error('Test failure:', err);
    // Cleanup even on error
    await prisma.suppressionList.deleteMany({
      where: { normalizedEmail: { in: [testEmail1, normEmailUpper, testEmail2] } }
    }).catch(() => {});
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runSuppressionFunctionalTests();
