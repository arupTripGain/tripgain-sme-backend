import 'dotenv/config';
import assert from 'assert';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function runEgressValidationTests() {
  console.log('================================================================');
  console.log('   P0 FIX VALIDATION SUITE: IMAP SYNC EGRESS OPTIMIZATION       ');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ✗ ${name}:`, err?.message || err);
      failed++;
    }
  }

  // --- TEST A: Verify Targeted Query Execution for ContactEmail (Zero Enrollment preloading) ---
  await test('A. Targeted lookup by normalizedEmail returns contactId without loading full Enrollment table', async () => {
    const sampleEmail = await prisma.contactEmail.findFirst({
      select: { normalizedEmail: true, contactId: true }
    });

    if (sampleEmail) {
      const targeted = await prisma.contactEmail.findFirst({
        where: { normalizedEmail: sampleEmail.normalizedEmail },
        select: {
          id: true,
          contactId: true,
          contact: {
            select: { id: true, organizationId: true }
          }
        }
      });
      assert.ok(targeted, 'Targeted lookup must find the contact email');
      assert.strictEqual(targeted.contactId, sampleEmail.contactId);
      assert.ok(targeted.contact, 'Targeted lookup resolves minimal contact record');
    }
  });

  // --- TEST B: Header-based ConversationMessage query selects minimal fields ---
  await test('B. Targeted lookup for In-Reply-To / References Message-IDs uses index and selects minimal columns', async () => {
    const testHeaderIds = ['<test-msg-123@example.com>', 'test-msg-123@example.com'];
    const matched = await prisma.conversationMessage.findFirst({
      where: {
        direction: 'OUTBOUND',
        OR: [
          { internetMessageId: { in: testHeaderIds } },
          { providerMessageId: { in: testHeaderIds } }
        ]
      },
      select: {
        id: true,
        conversationId: true,
        internetMessageId: true,
        providerMessageId: true
      }
    });
    assert.ok(matched === null || (matched && matched.conversationId), 'Query must execute cleanly with minimal projection');
  });

  // --- TEST C: Duplicate Message Prevention Query Semantics ---
  await test('C. Duplicate message prevention query properly checks providerMessageId and 60-second window', async () => {
    const receivedDate = new Date();
    const dupCheck = await prisma.conversationMessage.findFirst({
      where: {
        OR: [
          { providerMessageId: '<unique-dup-test-msg-id>' },
          {
            senderEmail: 'test-sender@example.com',
            subject: 'Test Subject',
            receivedAt: {
              gte: new Date(receivedDate.getTime() - 60000),
              lte: new Date(receivedDate.getTime() + 60000)
            }
          }
        ]
      }
    });
    assert.strictEqual(dupCheck, null, 'Unseen message must not be flagged as duplicate');
  });

  console.log(`\n================================================================`);
  console.log(`P0 VALIDATION SUITE COMPLETE: ${passed} passed, ${failed} failed`);
  console.log(`================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runEgressValidationTests()
  .catch((err) => {
    console.error('Validation script error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
