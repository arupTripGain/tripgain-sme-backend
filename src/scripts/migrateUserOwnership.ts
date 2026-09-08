import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function migrateUserOwnership() {
  console.log('[Migration] Starting user ownership migration...');

  // 1. Find the primary admin user
  const admin = await prisma.user.findFirst({
    where: { email: 'admin@tripgain.com' }
  });

  if (!admin) {
    console.error('Admin user (admin@tripgain.com) not found!');
    process.exit(1);
  }

  console.log(`[Migration] Found Admin User: ${admin.name} (${admin.id})`);

  // 2. Associate unassigned mailboxes with admin
  const unassignedMailboxes = await prisma.mailbox.findMany({
    where: { userId: null }
  });

  console.log(`[Migration] Found ${unassignedMailboxes.length} unassigned mailbox(es).`);

  for (const mb of unassignedMailboxes) {
    await prisma.mailbox.update({
      where: { id: mb.id },
      data: {
        userId: admin.id,
        ownerName: admin.name || 'Arup Nirala'
      }
    });
    console.log(` - Assigned mailbox ${mb.email} to ${admin.name}`);
  }

  // 3. Associate unassigned campaigns with admin
  const unassignedCampaigns = await (prisma as any).campaign.findMany({
    where: {
      OR: [
        { userId: null },
        { owner: null }
      ]
    }
  });

  console.log(`[Migration] Found ${unassignedCampaigns.length} unassigned campaign(s).`);

  for (const camp of unassignedCampaigns) {
    await (prisma as any).campaign.update({
      where: { id: camp.id },
      data: {
        userId: admin.id,
        owner: admin.name || 'Arup Nirala'
      }
    });
    console.log(` - Assigned campaign "${camp.name}" to ${admin.name}`);
  }

  console.log('[Migration] User ownership migration completed successfully!');
}

migrateUserOwnership()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    prisma.$disconnect();
    process.exit(1);
  });
