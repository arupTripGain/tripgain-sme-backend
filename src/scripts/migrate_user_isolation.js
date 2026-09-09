const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('[Migration] Starting user data ownership backfill...');

  // 1. Locate Admin User: Arup Nirala
  const adminUser = await prisma.user.findFirst({
    where: {
      OR: [
        { email: 'admin@tripgain.com' },
        { id: '07b35148-6de7-4ea4-8702-7b4543764ad6' }
      ]
    }
  });

  if (!adminUser) {
    throw new Error('Admin user Arup Nirala (admin@tripgain.com) not found in database!');
  }

  const arupUserId = adminUser.id;
  console.log(`[Migration] Authoritative Admin User identified: ${adminUser.name} (${adminUser.email}), ID: ${arupUserId}`);

  // 2. Backfill Contact records
  const updatedContacts = await prisma.contact.updateMany({
    where: { userId: null },
    data: { userId: arupUserId }
  });
  console.log(`[Migration] Successfully assigned ${updatedContacts.count} legacy contacts to ${adminUser.name}.`);

  // 3. Backfill List records
  const updatedLists = await prisma.list.updateMany({
    where: { userId: null },
    data: { userId: arupUserId }
  });
  console.log(`[Migration] Successfully assigned ${updatedLists.count} legacy lists to ${adminUser.name}.`);

  // 4. Verify Campaigns ownership
  const unassignedCampaigns = await prisma.campaign.updateMany({
    where: { userId: null },
    data: { userId: arupUserId }
  });
  console.log(`[Migration] Verified campaigns. (${unassignedCampaigns.count} unassigned campaigns updated to ${adminUser.name}).`);

  // 5. Verify Mailboxes ownership
  const unassignedMailboxes = await prisma.mailbox.updateMany({
    where: { userId: null },
    data: { userId: arupUserId }
  });
  console.log(`[Migration] Verified mailboxes. (${unassignedMailboxes.count} unassigned mailboxes updated to ${adminUser.name}).`);

  // 6. Verification counts
  const totalContacts = await prisma.contact.count({ where: { userId: arupUserId } });
  const totalLists = await prisma.list.count({ where: { userId: arupUserId } });
  const totalCampaigns = await prisma.campaign.count({ where: { userId: arupUserId } });
  const totalMailboxes = await prisma.mailbox.count({ where: { userId: arupUserId } });

  console.log(`[Migration] Data Integrity Summary for ${adminUser.name}:`);
  console.log(`  - Contacts: ${totalContacts}`);
  console.log(`  - Lists: ${totalLists}`);
  console.log(`  - Campaigns: ${totalCampaigns}`);
  console.log(`  - Mailboxes: ${totalMailboxes}`);
  console.log('[Migration] Migration completed safely with zero deletions.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
