import { PrismaClient } from '@prisma/client';
import { bulkImportContacts } from '../src/controllers/contactController';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../src/middleware/authMiddleware';

const prisma = new PrismaClient();

async function runTests() {
  console.log('=== STARTING BULK IMPORT TESTS ===');
  
  // 1. Setup test user
  const testEmail = `test_bulk_user_${Date.now()}@example.com`;
  let user = await prisma.user.create({
    data: { email: testEmail, name: 'Bulk Test User' }
  });
  
  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET);

  const mockReq = (body: any) => ({
    body,
    headers: { authorization: `Bearer ${token}` }
  } as any);

  const mockRes = () => {
    const res: any = {};
    res.statusCode = 200;
    res.status = (code: number) => {
      res.statusCode = code;
      return res;
    };
    res.json = (data: any) => {
      res.data = data;
      return res;
    };
    return res;
  };

  try {
    // TEST 1: Import batch with newListName, duplicates inside batch, and invalid emails
    console.log('\n--- Test 1: Bulk import with mixed data, duplicates, and new list ---');
    const req1 = mockReq({
      newListName: `Test List ${Date.now()}`,
      contacts: [
        { email: 'alice@company-a.com', firstName: 'Alice', lastName: 'A', companyName: 'Company A', domain: 'company-a.com' },
        { email: 'bob@company-b.com', firstName: 'Bob', lastName: 'B', companyName: 'Company B', domain: 'https://www.company-b.com/' },
        { email: 'ALICE@company-a.com', firstName: 'Alice Duplicate', lastName: 'A' }, // Duplicate within batch
        { email: 'charlie@gmail.com', firstName: 'Charlie', lastName: 'C', companyName: 'Gmail Co' },
        { email: 'invalid-email-format', firstName: 'Invalid' } // Invalid email
      ]
    });
    const res1 = mockRes();
    await bulkImportContacts(req1, res1);

    console.log('Test 1 Response:', res1.data);
    if (res1.statusCode !== 200) throw new Error(`Expected 200, got ${res1.statusCode}`);
    if (res1.data.new !== 3) throw new Error(`Expected 3 new contacts, got ${res1.data.new}`);
    if (res1.data.duplicates !== 1) throw new Error(`Expected 1 duplicate, got ${res1.data.duplicates}`);
    if (res1.data.invalid !== 1) throw new Error(`Expected 1 invalid, got ${res1.data.invalid}`);
    if (!res1.data.listId) throw new Error('Expected listId to be returned');
    console.log('✔ Test 1 Passed: Correctly imported 3 new, 1 duplicate, 1 invalid, created list.');

    const targetListId = res1.data.listId;

    // TEST 2: Second batch with same listId
    console.log('\n--- Test 2: Second batch targeting existing listId ---');
    const req2 = mockReq({
      listId: targetListId,
      contacts: [
        { email: 'alice@company-a.com', firstName: 'Alice' }, // Already exists
        { email: 'david@company-c.com', firstName: 'David', companyName: 'Company C' }
      ]
    });
    const res2 = mockRes();
    await bulkImportContacts(req2, res2);

    console.log('Test 2 Response:', res2.data);
    if (res2.statusCode !== 200) throw new Error(`Expected 200, got ${res2.statusCode}`);
    if (res2.data.new !== 1) throw new Error(`Expected 1 new, got ${res2.data.new}`);
    if (res2.data.duplicates !== 1) throw new Error(`Expected 1 duplicate, got ${res2.data.duplicates}`);
    console.log('✔ Test 2 Passed: Correctly identified 1 existing duplicate and 1 new.');

    // TEST 3: Idempotent list name reuse
    console.log('\n--- Test 3: Idempotent newListName reuse ---');
    const list = await prisma.list.findUnique({ where: { id: targetListId } });
    const req3 = mockReq({
      newListName: list!.name,
      contacts: [
        { email: 'eva@company-d.com', firstName: 'Eva' }
      ]
    });
    const res3 = mockRes();
    await bulkImportContacts(req3, res3);

    console.log('Test 3 Response:', res3.data);
    if (res3.data.listId !== targetListId) throw new Error('Expected existing listId to be reused');
    console.log('✔ Test 3 Passed: Successfully reused existing list instead of creating duplicates.');

    console.log('\n=========================================');
    console.log('ALL BULK IMPORT TESTS PASSED SUCCESSFULLY!');
    console.log('=========================================');
  } finally {
    // Cleanup test data
    try {
      const contacts = await prisma.contact.findMany({ where: { userId: user.id } });
      const contactIds = contacts.map(c => c.id);
      await prisma.listMember.deleteMany({ where: { contactId: { in: contactIds } } });
      await prisma.contactEmail.deleteMany({ where: { contactId: { in: contactIds } } });
      await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
      await prisma.list.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    } catch (cleanErr) {
      console.warn('Cleanup warning:', cleanErr);
    }
  }
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
