import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

export async function seedUsers() {
  console.log('[Auth] Seeding initial users...');

  // 1. Get or create primary workspace
  let workspace = await prisma.workspace.findFirst();
  
  const hashedPassword = await bcrypt.hash('password123', 10);

  // 2. Upsert Admin User (Arup Nirala)
  const admin = await prisma.user.upsert({
    where: { email: 'admin@tripgain.com' },
    update: {
      name: 'Arup Nirala',
      role: 'ADMIN',
      passwordHash: hashedPassword,
    },
    create: {
      email: 'admin@tripgain.com',
      name: 'Arup Nirala',
      role: 'ADMIN',
      passwordHash: hashedPassword,
    }
  });

  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: {
        name: 'TripGain',
        userId: admin.id
      }
    });
  }

  // Update admin's workspace
  await prisma.user.update({
    where: { id: admin.id },
    data: { workspaceId: workspace.id }
  });

  // 3. Upsert Team Member 1: Sarah Jenkins (Outreach Rep)
  await prisma.user.upsert({
    where: { email: 'sarah.jenkins@tripgain.com' },
    update: {
      name: 'Sarah Jenkins',
      role: 'MEMBER',
      passwordHash: hashedPassword,
      workspaceId: workspace.id
    },
    create: {
      email: 'sarah.jenkins@tripgain.com',
      name: 'Sarah Jenkins',
      role: 'MEMBER',
      passwordHash: hashedPassword,
      workspaceId: workspace.id
    }
  });

  // 4. Upsert Team Member 2: Vikram Malhotra (Campaign Manager)
  await prisma.user.upsert({
    where: { email: 'vikram.malhotra@tripgain.com' },
    update: {
      name: 'Vikram Malhotra',
      role: 'MANAGER',
      passwordHash: hashedPassword,
      workspaceId: workspace.id
    },
    create: {
      email: 'vikram.malhotra@tripgain.com',
      name: 'Vikram Malhotra',
      role: 'MANAGER',
      passwordHash: hashedPassword,
      workspaceId: workspace.id
    }
  });

  console.log('[Auth] Initial users verified:');
  console.log(' - admin@tripgain.com (Arup Nirala, ADMIN)');
  console.log(' - sarah.jenkins@tripgain.com (Sarah Jenkins, MEMBER)');
  console.log(' - vikram.malhotra@tripgain.com (Vikram Malhotra, MANAGER)');
  console.log(' - Password for all initial users: password123');
}

if (require.main === module) {
  seedUsers()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
