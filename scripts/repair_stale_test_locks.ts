import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TARGET_CAMPAIGN_ID = 'f2644f9d-3a3f-48e0-80a4-111cfb9d8699';
const TARGET_ENROLLMENT_IDS = [
  'd723b088-6814-44c8-8e60-e7919ba45745',
  'aac77f6b-b440-4ba9-b276-06abdf7cc30e',
  '8b4a9643-2ac5-4358-b65c-646685e8aedf',
  '7dc752b7-35e3-416f-82ce-654754ee12d7',
  'b530cfe3-3f96-44f8-bbef-1b747836f6e0'
];

async function main() {
  console.log('[Repair] Starting one-time idempotent repair for stale test locks...');

  // 1. Verify all 5 enrollment IDs belong to target campaign
  const foundEnrollments = await prisma.enrollment.findMany({
    where: {
      id: { in: TARGET_ENROLLMENT_IDS }
    },
    select: {
      id: true,
      campaignId: true,
      currentStep: true,
      status: true,
      nextSendAt: true,
      lastSentAt: true,
      mailboxId: true,
      lockedAt: true,
      lockedBy: true,
      lockExpiresAt: true
    }
  });

  if (foundEnrollments.length !== TARGET_ENROLLMENT_IDS.length) {
    throw new Error(`[Repair] Expected ${TARGET_ENROLLMENT_IDS.length} enrollments, found ${foundEnrollments.length}`);
  }

  for (const e of foundEnrollments) {
    if (e.campaignId !== TARGET_CAMPAIGN_ID) {
      throw new Error(`[Repair] Enrollment ${e.id} belongs to unexpected campaign ${e.campaignId}, aborting!`);
    }
  }

  console.log(`[Repair] Verified all ${foundEnrollments.length} enrollments belong to campaign ${TARGET_CAMPAIGN_ID}.`);

  // 2. Clear ONLY lock fields (idempotent)
  const result = await prisma.enrollment.updateMany({
    where: {
      id: { in: TARGET_ENROLLMENT_IDS },
      campaignId: TARGET_CAMPAIGN_ID
    },
    data: {
      lockedAt: null,
      lockedBy: null,
      lockExpiresAt: null
    }
  });

  console.log(`[Repair] Successfully cleared stale locks for ${result.count} enrollments.`);

  // 3. Re-verify post-repair state
  const verified = await prisma.enrollment.findMany({
    where: { id: { in: TARGET_ENROLLMENT_IDS } },
    select: {
      id: true,
      status: true,
      currentStep: true,
      mailboxId: true,
      nextSendAt: true,
      lockedAt: true,
      lockedBy: true,
      lockExpiresAt: true
    }
  });

  for (const v of verified) {
    console.log(`[Repair] Enrollment ${v.id}: status=${v.status}, step=${v.currentStep}, mailboxId=${v.mailboxId}, locked=${v.lockedAt !== null}`);
  }
}

main()
  .catch((err) => {
    console.error('[Repair] Error executing repair:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
