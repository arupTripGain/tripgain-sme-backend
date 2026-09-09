import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const prisma = new PrismaClient();

const TARGET_CAMPAIGN_ID = '71ef54ea-c3f1-4e95-9779-1571311c52f6';
const EXPECTED_SENDER_EMAIL = 'arup.nirala@tripgainapp.com';
const TARGET_MAILBOX_ID = '54dc7f72-9eb9-4442-9763-83b4f1f84fc1';

const TARGET_ENROLLMENT_IDS = [
  '618c6680-861b-4b3a-a03e-9b43439189e6',
  '9f67f7e7-6542-4910-b50c-cf475feeda43',
  'b97a2297-ad42-41a9-a484-3b9cdd49ce1d',
  'a3056d20-5a08-468c-9c18-56e13dbf0e09',
  'e5aad783-040a-4170-bf6a-87a2d592bbd1',
  '27f67d5a-be79-4ed1-bd8f-7e12b54bd76d',
  'a3a1d968-16ec-45bc-b0e8-5684c2efda01'
];

async function repairOrphanedTestEnrollments() {
  console.log('====================================================');
  console.log('TARGETED ONE-TIME REPAIR: 7 TEST ENROLLMENTS');
  console.log('Restoring Verified Sender Affinity for Historical Leads');
  console.log('====================================================\n');

  // 1. Verify Target Mailbox
  const mailbox = await prisma.mailbox.findUnique({
    where: { id: TARGET_MAILBOX_ID },
    select: { id: true, email: true, status: true, isActive: true }
  });

  if (!mailbox) {
    throw new Error(`Target mailbox ${TARGET_MAILBOX_ID} not found in database!`);
  }
  if (mailbox.email.toLowerCase().trim() !== EXPECTED_SENDER_EMAIL) {
    throw new Error(`Mailbox email mismatch! Expected ${EXPECTED_SENDER_EMAIL}, found ${mailbox.email}`);
  }
  console.log(`[Verification] Target Mailbox verified: ${mailbox.email} (ID: ${mailbox.id}, Status: ${mailbox.status}, Active: ${mailbox.isActive})\n`);

  let repairedCount = 0;
  let alreadyRepairedCount = 0;
  let skippedCount = 0;

  for (const enrollmentId of TARGET_ENROLLMENT_IDS) {
    const enrollment = await prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: {
        contact: {
          include: { emails: true }
        }
      }
    });

    if (!enrollment) {
      console.warn(`[Skip] Enrollment ${enrollmentId} not found.`);
      skippedCount++;
      continue;
    }

    if (enrollment.campaignId !== TARGET_CAMPAIGN_ID) {
      console.warn(`[Skip] Enrollment ${enrollmentId} belongs to campaign ${enrollment.campaignId}, not target campaign.`);
      skippedCount++;
      continue;
    }

    const leadEmail = enrollment.contact?.emails?.[0]?.email || 'unknown';

    // Idempotency check
    if (enrollment.mailboxId === TARGET_MAILBOX_ID) {
      console.log(`[Idempotent] Enrollment ${enrollmentId} (${leadEmail}) already connected to mailbox ${TARGET_MAILBOX_ID}.`);
      alreadyRepairedCount++;
      continue;
    }

    if (enrollment.mailboxId !== null) {
      console.warn(`[Skip] Enrollment ${enrollmentId} (${leadEmail}) already has a different mailboxId: ${enrollment.mailboxId}. Preserving.`);
      skippedCount++;
      continue;
    }

    // Verify historical outbound Step 1 message
    const outboundMessage = await prisma.emailMessage.findFirst({
      where: {
        enrollmentId,
        status: { in: ['sent', 'delivered', 'opened', 'clicked', 'bounced'] }
      },
      select: {
        id: true,
        fromEmail: true,
        sentAt: true,
        subject: true
      }
    });

    if (!outboundMessage) {
      console.warn(`[Skip] Enrollment ${enrollmentId} (${leadEmail}) has no historical sent message. Skipping.`);
      skippedCount++;
      continue;
    }

    const messageFrom = outboundMessage.fromEmail.toLowerCase().trim();
    if (messageFrom !== EXPECTED_SENDER_EMAIL) {
      console.warn(`[Skip] Enrollment ${enrollmentId} Step 1 was sent from ${messageFrom}, not ${EXPECTED_SENDER_EMAIL}. Skipping.`);
      skippedCount++;
      continue;
    }

    // Verified! Set ONLY mailboxId to reconnect original sending mailbox
    await prisma.enrollment.update({
      where: { id: enrollmentId },
      data: {
        mailboxId: TARGET_MAILBOX_ID
      }
    });

    console.log(`✔ [Repaired] Enrollment ${enrollmentId} (${leadEmail}): linked to original mailbox ${TARGET_MAILBOX_ID} (${EXPECTED_SENDER_EMAIL}).`);
    repairedCount++;
  }

  console.log('\n====================================================');
  console.log(`REPAIR SUMMARY:`);
  console.log(`Total Target Enrollments:  ${TARGET_ENROLLMENT_IDS.length}`);
  console.log(`Successfully Repaired:     ${repairedCount}`);
  console.log(`Already Repaired:          ${alreadyRepairedCount}`);
  console.log(`Skipped / Unverified:      ${skippedCount}`);
  console.log('====================================================\n');
}

repairOrphanedTestEnrollments()
  .catch(e => {
    console.error('Fatal repair error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
