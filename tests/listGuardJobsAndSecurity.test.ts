import 'dotenv/config';
import assert from 'assert';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { ListGuardQueue } from '../src/services/listGuard/listGuardQueue';
import { ListGuardStore } from '../src/services/listGuard/listGuardStore';
import { ListGuardWorker } from '../src/workers/listGuardWorker';
import { setTestSmtpMockHandler } from '../src/services/listGuard/smtpVerifier';
import {
  getDashboard,
  startVerificationJob,
  getJobStatus,
  cancelJob,
  getJobResults,
  exportResults,
  createCleanList,
  updateList,
  getListHistory
} from '../src/controllers/listGuardController';

const TEST_DATABASE_URL = "postgresql://neondb_owner:npg_KRSH2nqwsjL0@ep-snowy-cell-b3gndpl3-pooler.c-4.ap-southeast-1.aws.neon.tech/listguard_test_db?sslmode=require&channel_binding=require";
process.env.DATABASE_URL = TEST_DATABASE_URL;

const prisma = new PrismaClient({
  datasources: { db: { url: TEST_DATABASE_URL } }
});
const JWT_SECRET = process.env.JWT_SECRET || 'tripgain_dev_jwt_secret_change_in_production';

function createMockReqRes(options: {
  token?: string | null;
  user?: any;
  params?: Record<string, string>;
  query?: Record<string, any>;
  body?: any;
}) {
  let statusCode = 200;
  let responseData: any = null;
  let headers: Record<string, string> = {};

  const req: any = {
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    params: options.params || {},
    query: options.query || {},
    body: options.body || {},
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
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    get statusCode() {
      return statusCode;
    },
    get data() {
      return responseData;
    },
    get headers() {
      return headers;
    }
  };

  return { req, res };
}

async function runListGuardJobsAndSecurityTests() {
  console.log('--- STARTING LISTGUARD JOBS & SECURITY TEST SUITE ---');

  let passed = 0;
  let total = 0;

  function test(name: string, fn: () => void | Promise<void>) {
    total++;
    try {
      const res = fn();
      if (res instanceof Promise) {
        return res
          .then(() => {
            passed++;
            console.log(`  ✓ ${name}`);
          })
          .catch((err) => {
            console.error(`  ✗ ${name}`);
            console.error(err);
            throw err;
          });
      } else {
        passed++;
        console.log(`  ✓ ${name}`);
      }
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(err);
      throw err;
    }
  }

  // Clean up any lingering jobs from previous test runs in test DB
  await prisma.emailVerificationResult.deleteMany({}).catch(() => {});
  await prisma.emailVerificationJob.deleteMany({}).catch(() => {});

  // Setup test users & workspace
  const userA = await prisma.user.upsert({
    where: { email: 'listguard_user_a@tripgain.com' },
    update: {},
    create: { email: 'listguard_user_a@tripgain.com', name: 'User A', role: 'MEMBER' }
  });

  const userB = await prisma.user.upsert({
    where: { email: 'listguard_user_b@tripgain.com' },
    update: {},
    create: { email: 'listguard_user_b@tripgain.com', name: 'User B', role: 'MEMBER' }
  });

  const workspace = await prisma.workspace.findFirst({ where: { userId: userA.id } }) ||
    await prisma.workspace.create({ data: { name: 'Test WS', userId: userA.id } });

  const tokenA = jwt.sign({ userId: userA.id, email: userA.email, role: userA.role }, JWT_SECRET);
  const tokenB = jwt.sign({ userId: userB.id, email: userB.email, role: userB.role }, JWT_SECRET);

  // Setup mock SMTP handler so tests run deterministically and fast
  setTestSmtpMockHandler(async (email) => {
    if (email.includes('undeliverable')) {
      return {
        smtpStatus: 'UNDELIVERABLE_SIGNAL',
        isCatchAll: false,
        smtpResponseCode: '550',
        smtpResponse: '550 User unknown',
        attempts: 1
      };
    }
    if (email.includes('deliverable')) {
      return {
        smtpStatus: 'DELIVERABLE_SIGNAL',
        isCatchAll: false,
        smtpResponseCode: '250',
        smtpResponse: '250 OK',
        attempts: 1
      };
    }
    if (email.includes('catchall')) {
      return {
        smtpStatus: 'CATCH_ALL',
        isCatchAll: true,
        smtpResponseCode: '250',
        smtpResponse: '250 OK catch-all',
        attempts: 1
      };
    }
    return {
      smtpStatus: 'UNKNOWN',
      isCatchAll: false,
      smtpResponseCode: '450',
      smtpResponse: '450 Temporary greylist',
      attempts: 3
    };
  });

  // Create test contacts for User A
  const contact1 = await prisma.contact.create({
    data: {
      userId: userA.id,
      workspaceId: workspace.id,
      firstName: 'Aarav',
      lastName: 'Patel',
      jobTitle: 'VP Technology',
      city: 'Bengaluru',
      emails: {
        create: [
          { email: 'aarav.deliverable@google.com', normalizedEmail: 'aarav.deliverable@google.com', isPrimary: true }
        ]
      }
    }
  });

  const contact2 = await prisma.contact.create({
    data: {
      userId: userA.id,
      workspaceId: workspace.id,
      firstName: 'Priya',
      lastName: 'Nair',
      jobTitle: 'Head of Sales',
      city: 'Mumbai',
      emails: {
        create: [
          { email: 'priya.catchall@google.com', normalizedEmail: 'priya.catchall@google.com', isPrimary: true }
        ]
      }
    }
  });

  const contact3 = await prisma.contact.create({
    data: {
      userId: userA.id,
      workspaceId: workspace.id,
      firstName: 'Rohan',
      lastName: 'Mehta',
      jobTitle: 'Procurement Director',
      city: 'Delhi',
      emails: {
        create: [
          { email: 'rohan.undeliverable@google.com', normalizedEmail: 'rohan.undeliverable@google.com', isPrimary: true }
        ]
      }
    }
  });

  // Create List for User A
  const listA = await prisma.list.create({
    data: {
      name: 'User A Outreach Raw List',
      userId: userA.id,
      workspaceId: workspace.id,
      listType: 'static',
      members: {
        create: [
          { contactId: contact1.id, membershipStatus: 'active' },
          { contactId: contact2.id, membershipStatus: 'active' },
          { contactId: contact3.id, membershipStatus: 'active' }
        ]
      }
    }
  });

  // Create List for User B
  const listB = await prisma.list.create({
    data: {
      name: 'User B Confidential List',
      userId: userB.id,
      workspaceId: workspace.id,
      listType: 'static'
    }
  });

  let createdJobId: string = '';

  // -------------------------------------------------------------
  // 1. ASYNC VERIFICATION JOBS & LIFECYCLE
  // -------------------------------------------------------------
  console.log('\n[1] Async Job Lifecycle Tests:');

  await test('POST /api/listguard/jobs starts asynchronous verification job', async () => {
    const { req, res } = createMockReqRes({
      token: tokenA,
      body: { listId: listA.id }
    });

    await startVerificationJob(req, res);
    assert.strictEqual(res.statusCode, 201);
    assert.ok(res.data.jobId);
    assert.strictEqual(res.data.total, 3);
    createdJobId = res.data.jobId;
  });

  await test('GET /api/listguard/jobs/:jobId reports job progress & completes correctly', async () => {
    // Process job using dedicated ListGuardWorker
    const testWorker = new ListGuardWorker({ prisma });
    const targetJob = await ListGuardStore.findJobById(prisma, createdJobId);
    if (targetJob) {
      await testWorker.processJob(targetJob);
    }

    const { req, res } = createMockReqRes({
      token: tokenA,
      params: { jobId: createdJobId }
    });

    await getJobStatus(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.status, 'COMPLETED');
    assert.strictEqual(res.data.total, 3);
    assert.strictEqual(res.data.processed, 3);
    assert.strictEqual(res.data.deliverable, 1);
    assert.strictEqual(res.data.catchAll, 1);
    assert.strictEqual(res.data.undeliverable, 1);
  });

  await test('GET /api/listguard/dashboard returns lists with verification summaries', async () => {
    const { req, res } = createMockReqRes({
      token: tokenA
    });

    await getDashboard(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(Array.isArray(res.data.lists));
    const found = res.data.lists.find((l: any) => l.id === listA.id);
    assert.ok(found);
    assert.strictEqual(found.contactCount, 3);
    assert.ok(found.latestVerification);
    assert.strictEqual(found.latestVerification.deliverable, 1);
    assert.strictEqual(found.latestVerification.catchAll, 1);
  });

  await test('POST /api/listguard/jobs/:jobId/cancel cancels a running/queued job', async () => {
    const jobToCancel = await ListGuardStore.createJob(prisma, {
      listId: listA.id,
      createdByUserId: userA.id,
      status: 'QUEUED',
      total: 10
    });

    const { req, res } = createMockReqRes({
      token: tokenA,
      params: { jobId: jobToCancel.id }
    });

    await cancelJob(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);

    const cancelledJob = await ListGuardStore.findJobById(prisma, jobToCancel.id, userA.id);
    assert.strictEqual(cancelledJob?.status, 'CANCELLED');
  });

  // -------------------------------------------------------------
  // 2. RESULTS FILTERING & SEARCH
  // -------------------------------------------------------------
  console.log('\n[2] Results Filtering & Search:');

  await test('GET /api/listguard/jobs/:jobId/results returns all records with contact info', async () => {
    const { req, res } = createMockReqRes({
      token: tokenA,
      params: { jobId: createdJobId },
      query: { filter: 'ALL' }
    });

    await getJobResults(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.totalCount, 3);
    assert.strictEqual(res.data.results.length, 3);
    assert.ok(res.data.results.some((r: any) => r.contact?.firstName === 'Aarav'));
  });

  await test('Filters results by DELIVERABLE only', async () => {
    const { req, res } = createMockReqRes({
      token: tokenA,
      params: { jobId: createdJobId },
      query: { filter: 'DELIVERABLE' }
    });

    await getJobResults(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.totalCount, 1);
    assert.strictEqual(res.data.results[0].result, 'DELIVERABLE');
    assert.strictEqual(res.data.results[0].email, 'aarav.deliverable@google.com');
  });

  await test('Searches results by contact name', async () => {
    const { req, res } = createMockReqRes({
      token: tokenA,
      params: { jobId: createdJobId },
      query: { search: 'Priya' }
    });

    await getJobResults(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.totalCount, 1);
    assert.strictEqual(res.data.results[0].result, 'CATCH_ALL');
  });

  // -------------------------------------------------------------
  // 3. COMPLETE CSV EXPORT
  // -------------------------------------------------------------
  console.log('\n[3] Complete CSV Export Tests:');

  await test('GET /api/listguard/jobs/:jobId/export exports complete dataset, preserving contact attributes', async () => {
    const { req, res } = createMockReqRes({
      token: tokenA,
      params: { jobId: createdJobId },
      query: { results: 'DELIVERABLE,CATCH_ALL,UNDELIVERABLE', includeDetails: 'true' }
    });

    await exportResults(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/csv'));
    assert.ok(res.headers['content-disposition'].includes('attachment'));

    const csvStr = String(res.data);
    const lines = csvStr.split('\r\n').filter(Boolean);
    // Line 0 is header, followed by 3 records
    assert.strictEqual(lines.length, 4);

    // Header validation
    const header = lines[0] || '';
    assert.ok(header.includes('Company'));
    assert.ok(header.includes('First Name'));
    assert.ok(header.includes('Email'));
    assert.ok(header.includes('Email Status'));
    assert.ok(header.includes('Catch-all'));
    assert.ok(header.includes('Verification Date'));

    // Verify contact name & status presence
    assert.ok(csvStr.includes('Aarav'));
    assert.ok(csvStr.includes('Priya'));
    assert.ok(csvStr.includes('Rohan'));
    assert.ok(csvStr.includes('DELIVERABLE'));
    assert.ok(csvStr.includes('CATCH_ALL'));
    assert.ok(csvStr.includes('UNDELIVERABLE'));
  });

  await test('Export respects selected status filters (e.g. DELIVERABLE only)', async () => {
    const { req, res } = createMockReqRes({
      token: tokenA,
      params: { jobId: createdJobId },
      query: { results: 'DELIVERABLE', includeDetails: 'false' }
    });

    await exportResults(req, res);
    assert.strictEqual(res.statusCode, 200);
    const csvStr = String(res.data);
    const lines = csvStr.split('\r\n').filter(Boolean);
    assert.strictEqual(lines.length, 2); // Header + 1 deliverable record
    assert.ok(csvStr.includes('aarav.deliverable@google.com'));
    assert.ok(!csvStr.includes('priya.catchall@google.com'));
  });

  // -------------------------------------------------------------
  // 4. CLEAN LIST CREATION
  // -------------------------------------------------------------
  console.log('\n[4] Clean List Creation Tests:');

  let cleanListId: string = '';

  await test('POST /api/listguard/jobs/:jobId/create-list generates derived List without altering original list', async () => {
    const { req, res } = createMockReqRes({
      token: tokenA,
      params: { jobId: createdJobId },
      body: {
        name: 'User A – Clean Deliverable',
        statuses: ['DELIVERABLE']
      }
    });

    await createCleanList(req, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.name, 'User A – Clean Deliverable');
    assert.strictEqual(res.data.contactCount, 1);
    cleanListId = res.data.listId;

    // Verify derived list in database has 1 member
    const cleanMembers = await prisma.listMember.findMany({ where: { listId: cleanListId } });
    assert.strictEqual(cleanMembers.length, 1);
    assert.strictEqual(cleanMembers[0]?.contactId, contact1.id);

    // CRITICAL: Verify original list remains 100% untouched (still 3 members)
    const originalMembers = await prisma.listMember.findMany({ where: { listId: listA.id } });
    assert.strictEqual(originalMembers.length, 3);
  });

  await test('Allows creating multiple clean lists from same verification job (e.g. Catch-all list)', async () => {
    const { req, res } = createMockReqRes({
      token: tokenA,
      params: { jobId: createdJobId },
      body: {
        name: 'User A – Catch-all Segment',
        statuses: ['CATCH_ALL']
      }
    });

    await createCleanList(req, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.contactCount, 1);

    const secondListId = res.data.listId;
    const secondMembers = await prisma.listMember.findMany({ where: { listId: secondListId } });
    assert.strictEqual(secondMembers.length, 1);
    assert.strictEqual(secondMembers[0]?.contactId, contact2.id);

    // Cleanup second list
    await prisma.listMember.deleteMany({ where: { listId: secondListId } });
    await prisma.list.delete({ where: { id: secondListId } });
  });

  await test('POST /api/listguard/jobs/:jobId/update-list directly updates existing list memberships based on selected categories', async () => {
    const { req, res } = createMockReqRes({
      token: tokenA,
      params: { jobId: createdJobId },
      body: {
        statuses: ['DELIVERABLE']
      }
    });

    await updateList(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.keptCount, 1);
    assert.strictEqual(res.data.removedCount, 2);

    // Verify original list now has only the 1 deliverable contact
    const updatedMembers = await prisma.listMember.findMany({ where: { listId: listA.id } });
    assert.strictEqual(updatedMembers.length, 1);
    assert.strictEqual(updatedMembers[0]?.contactId, contact1.id);
  });

  // -------------------------------------------------------------
  // 5. MULTI-USER ISOLATION & SECURITY
  // -------------------------------------------------------------
  console.log('\n[5] Multi-User Security & Isolation Tests:');

  await test('User B cannot view User A verification job status', async () => {
    const { req, res } = createMockReqRes({
      token: tokenB, // Authenticated as User B
      params: { jobId: createdJobId }
    });

    await getJobStatus(req, res);
    assert.strictEqual(res.statusCode, 404);
  });

  await test('User B cannot view User A verification results', async () => {
    const { req, res } = createMockReqRes({
      token: tokenB,
      params: { jobId: createdJobId }
    });

    await getJobResults(req, res);
    assert.strictEqual(res.statusCode, 404);
  });

  await test('User B cannot export User A verification results', async () => {
    const { req, res } = createMockReqRes({
      token: tokenB,
      params: { jobId: createdJobId }
    });

    await exportResults(req, res);
    assert.strictEqual(res.statusCode, 404);
  });

  await test('User B cannot create a clean list from User A verification job', async () => {
    const { req, res } = createMockReqRes({
      token: tokenB,
      params: { jobId: createdJobId },
      body: {
        name: 'User B Infiltration List',
        statuses: ['DELIVERABLE']
      }
    });

    await createCleanList(req, res);
    assert.strictEqual(res.statusCode, 404);
  });

  await test('User B cannot update list from User A verification job', async () => {
    const { req, res } = createMockReqRes({
      token: tokenB,
      params: { jobId: createdJobId },
      body: {
        statuses: ['DELIVERABLE']
      }
    });

    await updateList(req, res);
    assert.strictEqual(res.statusCode, 404);
  });

  await test('User B cannot cancel User A verification job', async () => {
    const { req, res } = createMockReqRes({
      token: tokenB,
      params: { jobId: createdJobId }
    });

    await cancelJob(req, res);
    assert.strictEqual(res.statusCode, 404);
  });

  await test('User B cannot start verification on User A list', async () => {
    const { req, res } = createMockReqRes({
      token: tokenB,
      body: { listId: listA.id }
    });

    await startVerificationJob(req, res);
    assert.strictEqual(res.statusCode, 404);
  });

  // -------------------------------------------------------------
  // CLEANUP
  // -------------------------------------------------------------
  setTestSmtpMockHandler(null);

  if (cleanListId) {
    await prisma.listMember.deleteMany({ where: { listId: cleanListId } }).catch(() => {});
    await prisma.list.delete({ where: { id: cleanListId } }).catch(() => {});
  }
  await prisma.listMember.deleteMany({ where: { listId: listA.id } }).catch(() => {});
  await prisma.list.delete({ where: { id: listA.id } }).catch(() => {});
  await prisma.list.delete({ where: { id: listB.id } }).catch(() => {});
  await prisma.contactEmail.deleteMany({ where: { contactId: { in: [contact1.id, contact2.id, contact3.id] } } }).catch(() => {});
  await prisma.contact.deleteMany({ where: { id: { in: [contact1.id, contact2.id, contact3.id] } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } }).catch(() => {});

  console.log(`\n==================================================`);
  console.log(`LISTGUARD JOBS & SECURITY TESTS: ${passed}/${total} PASSED`);
  console.log(`==================================================`);
}

runListGuardJobsAndSecurityTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
