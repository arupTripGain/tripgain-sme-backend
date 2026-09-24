import 'dotenv/config';
import assert from 'assert';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { ListGuardQueue } from '../src/services/listGuard/listGuardQueue';
import { ListGuardStore } from '../src/services/listGuard/listGuardStore';
import { ListGuardWorker } from '../src/workers/listGuardWorker';
import { setTestSmtpMockHandler } from '../src/services/listGuard/smtpVerifier';
import {
  startVerificationJob,
  getJobStatus,
  getJobResults,
  exportResults,
  createCleanList,
  updateList
} from '../src/controllers/listGuardController';

// -------------------------------------------------------------
// CONFIGURE ACTUAL PERSISTENCE AGAINST ISOLATED TEST DATABASE
// (Ensures Production neondb is completely untouched)
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error('DATABASE_URL or TEST_DATABASE_URL environment variable must be set');
}
process.env.DATABASE_URL = TEST_DATABASE_URL;

let prisma = new PrismaClient({
  datasources: { db: { url: TEST_DATABASE_URL } }
});

const JWT_SECRET = process.env.JWT_SECRET || 'tripgain_dev_jwt_secret_change_in_production';

function createMockReqRes(options: {
  token?: string | null;
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
    body: options.body || {}
  };

  const res: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: any) {
      responseData = data;
      return this;
    },
    send(data: any) {
      responseData = data;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return this;
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

async function runListGuardPersistenceTests() {
  console.log('====================================================');
  console.log('  RUNNING LISTGUARD ACTUAL PRISMA PERSISTENCE TESTS ');
  console.log('  Testing PostgreSQL Persistence & Restart Survival  ');
  console.log('====================================================\n');

  let passed = 0;
  let total = 0;

  async function test(name: string, fn: () => Promise<void>) {
    total++;
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ✗ ${name}`);
      console.error(`    Error: ${err.message}`);
      throw err;
    }
  }

  // 1. Verify connection to listguard_test_db
  await test('Verifies connection to isolated test database (listguard_test_db)', async () => {
    const dbInfo: any = await prisma.$queryRawUnsafe(`SELECT current_database() as db;`);
    assert.strictEqual(dbInfo[0].db, 'listguard_test_db', 'Must be connected to listguard_test_db, never production!');
  });

  // 2. Verify table existence in listguard_test_db
  await test('Verifies EmailVerificationJob and EmailVerificationResult tables exist in PostgreSQL', async () => {
    const hasTables = await ListGuardStore.checkTableAvailability(prisma);
    assert.strictEqual(hasTables, true, 'Prisma persistence must find actual database tables, not fallback!');
    
    await prisma.emailVerificationResult.deleteMany({}).catch(() => {});
    await prisma.emailVerificationJob.deleteMany({}).catch(() => {});
    const count = await prisma.emailVerificationJob.count();
    assert.ok(typeof count === 'number');
  });

  // 3. Seed test user, workspace, contacts, and list
  const user = await prisma.user.create({
    data: {
      email: `test.persistence.${Date.now()}@tripgain.com`,
      name: 'Persistence Test Admin',
      role: 'ADMIN'
    }
  });

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const workspace = await prisma.workspace.findFirst({ where: { userId: user.id } }) ||
    await prisma.workspace.create({
      data: {
        name: 'Persistence Workspace',
        userId: user.id
      }
    });

  const contact1 = await prisma.contact.create({
    data: {
      userId: user.id,
      workspaceId: workspace.id,
      firstName: 'Vikram',
      lastName: 'Malhotra',
      jobTitle: 'VP Technology',
      city: 'Bengaluru',
      emails: {
        create: [
          { email: 'vikram.deliverable@google.com', normalizedEmail: 'vikram.deliverable@google.com', isPrimary: true }
        ]
      }
    }
  });

  const contact2 = await prisma.contact.create({
    data: {
      userId: user.id,
      workspaceId: workspace.id,
      firstName: 'Ananya',
      lastName: 'Roy',
      jobTitle: 'Operations Lead',
      city: 'Mumbai',
      emails: {
        create: [
          { email: 'ananya.catchall@google.com', normalizedEmail: 'ananya.catchall@google.com', isPrimary: true }
        ]
      }
    }
  });

  const contact3 = await prisma.contact.create({
    data: {
      userId: user.id,
      workspaceId: workspace.id,
      firstName: 'Kabir',
      lastName: 'Kapoor',
      jobTitle: 'Sales Director',
      city: 'Hyderabad',
      emails: {
        create: [
          { email: 'kabir.undeliverable@google.com', normalizedEmail: 'kabir.undeliverable@google.com', isPrimary: true }
        ]
      }
    }
  });

  const testList = await prisma.list.create({
    data: {
      name: 'Persisted High-Value Leads',
      userId: user.id,
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

  // Setup mock SMTP behavior
  setTestSmtpMockHandler(async (email) => {
    if (email.includes('undeliverable')) {
      return {
        smtpStatus: 'UNDELIVERABLE_SIGNAL',
        isCatchAll: false,
        smtpResponseCode: '550',
        smtpResponse: '550 5.1.1 User Unknown',
        attempts: 1
      };
    }
    if (email.includes('deliverable')) {
      return {
        smtpStatus: 'DELIVERABLE_SIGNAL',
        isCatchAll: false,
        smtpResponseCode: '250',
        smtpResponse: '250 2.1.5 Recipient OK',
        attempts: 1
      };
    }
    if (email.includes('catchall')) {
      return {
        smtpStatus: 'CATCH_ALL',
        isCatchAll: true,
        smtpResponseCode: '250',
        smtpResponse: '250 2.1.5 Catch-all Accepted',
        attempts: 1
      };
    }
    return {
      smtpStatus: 'UNKNOWN',
      isCatchAll: false,
      smtpResponseCode: '450',
      smtpResponse: '450 Greylist',
      attempts: 2
    };
  });

  let createdJobId: string = '';

  // 4. Run async verification job with Prisma persistence
  console.log('\n[1] Executing Verification Job against Database:');

  await test('Starts asynchronous verification job with actual Prisma DB writes', async () => {
    const { req, res } = createMockReqRes({
      token,
      body: { listId: testList.id }
    });

    await startVerificationJob(req, res);
    assert.strictEqual(res.statusCode, 201);
    createdJobId = res.data.jobId;
    assert.ok(createdJobId, 'Job ID must be returned');

    // Process job using dedicated ListGuardWorker against test database
    const testWorker = new ListGuardWorker({ prisma });
    const targetJob = await ListGuardStore.findJobById(prisma, createdJobId);
    if (targetJob) {
      await testWorker.processJob(targetJob);
    }
  });

  // 5. Verify direct database records in PostgreSQL
  console.log('\n[2] Direct Database Record Verification:');

  await test('Verifies EmailVerificationJob record exists in PostgreSQL', async () => {
    const dbJob = await prisma.emailVerificationJob.findUnique({
      where: { id: createdJobId }
    });
    assert.ok(dbJob, 'Job must exist in PostgreSQL');
    assert.strictEqual(dbJob.status, 'COMPLETED');
    assert.strictEqual(dbJob.total, 3);
    assert.strictEqual(dbJob.processed, 3);
    assert.strictEqual(dbJob.deliverable, 1);
    assert.strictEqual(dbJob.catchAll, 1);
    assert.strictEqual(dbJob.undeliverable, 1);
  });

  await test('Verifies EmailVerificationResult records exist in PostgreSQL', async () => {
    const dbResults = await prisma.emailVerificationResult.findMany({
      where: { jobId: createdJobId },
      orderBy: { email: 'asc' }
    });
    assert.strictEqual(dbResults.length, 3, 'All 3 results must exist in PostgreSQL');
    
    const deliverable = dbResults.find(r => r.result === 'DELIVERABLE');
    assert.ok(deliverable, 'Must have DELIVERABLE record in DB');
    assert.strictEqual(deliverable.contactId, contact1.id);
    assert.strictEqual(deliverable.smtpStatus, 'DELIVERABLE_SIGNAL');
    assert.strictEqual((deliverable as any).verificationReason, 'VALID_MAILBOX');

    const catchAll = dbResults.find(r => r.result === 'CATCH_ALL');
    assert.ok(catchAll, 'Must have CATCH_ALL record in DB');
    assert.strictEqual((catchAll as any).verificationReason, 'CATCH_ALL_DOMAIN');

    const undeliverable = dbResults.find(r => r.result === 'UNDELIVERABLE');
    assert.ok(undeliverable, 'Must have UNDELIVERABLE record in DB');
    assert.strictEqual((undeliverable as any).verificationReason, 'INVALID_MAILBOX');
  });

  // 6. SIMULATE BACKEND RESTART
  console.log('\n[3] Backend Restart Simulation:');

  await test('Completely purges in-memory state and instantiates fresh PrismaClient (Backend Restart)', async () => {
    // 1. Wipe in-memory caches and maps
    ListGuardStore.clearInMemoryForTesting();

    // 2. Disconnect old Prisma client
    await prisma.$disconnect();

    // 3. Re-instantiate brand new Prisma client from scratch
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL } }
    });

    const ping = await prisma.$queryRawUnsafe(`SELECT 1 as live;`);
    assert.ok(ping);
  });

  await test('Survives backend restart: findJobById reads completed job from PostgreSQL', async () => {
    const job = await ListGuardStore.findJobById(prisma, createdJobId, user.id);
    assert.ok(job, 'Job must survive backend restart');
    assert.strictEqual(job.id, createdJobId);
    assert.strictEqual(job.status, 'COMPLETED');
    assert.strictEqual(job.total, 3);
    assert.strictEqual(job.deliverable, 1);
  });

  await test('Survives backend restart: getAllResultsForJob reads verification results from PostgreSQL', async () => {
    const results = await ListGuardStore.getAllResultsForJob(prisma, createdJobId);
    assert.strictEqual(results.length, 3, 'All 3 results must survive backend restart');
  });

  await test('Survives backend restart: GET /api/listguard/jobs/:jobId returns full status', async () => {
    const { req, res } = createMockReqRes({
      token,
      params: { jobId: createdJobId }
    });

    await getJobStatus(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.status, 'COMPLETED');
    assert.strictEqual(res.data.deliverable, 1);
    assert.strictEqual(res.data.catchAll, 1);
    assert.strictEqual(res.data.undeliverable, 1);
  });

  await test('Survives backend restart: GET /api/listguard/jobs/:jobId/results returns paginated results with contacts', async () => {
    const { req, res } = createMockReqRes({
      token,
      params: { jobId: createdJobId },
      query: { page: '1', pageSize: '10' }
    });

    await getJobResults(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.totalCount, 3);
    assert.strictEqual(res.data.results.length, 3);

    // Verify contact relation populated from DB
    const first = res.data.results[0];
    assert.ok(first.contact, 'Contact info must be populated from PostgreSQL');
    assert.ok(first.contact.firstName);
    assert.ok(first.verificationReason, 'verificationReason must be populated');
  });

  // 7. VERIFY CSV EXPORT FROM PERSISTED RESULTS
  console.log('\n[4] CSV Export from Persisted DB Results:');

  await test('Exports complete CSV from PostgreSQL records with contact fields preserved', async () => {
    const { req, res } = createMockReqRes({
      token,
      params: { jobId: createdJobId },
      query: { includeDetails: 'true' }
    });

    await exportResults(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'text/csv; charset=utf-8');

    const csv = String(res.data);
    const lines = csv.split('\r\n').filter(Boolean);
    assert.strictEqual(lines.length, 4); // Header + 3 records

    assert.ok(csv.includes('Vikram'));
    assert.ok(csv.includes('Ananya'));
    assert.ok(csv.includes('Kabir'));
    assert.ok(csv.includes('DELIVERABLE'));
    assert.ok(csv.includes('CATCH_ALL'));
    assert.ok(csv.includes('UNDELIVERABLE'));
    assert.ok(csv.includes('Verification Reason'));
    assert.ok(csv.includes('VALID_MAILBOX'));
    assert.ok(csv.includes('CATCH_ALL_DOMAIN'));
    assert.ok(csv.includes('INVALID_MAILBOX'));
  });

  await test('Exports filtered CSV (DELIVERABLE only) from PostgreSQL records', async () => {
    const { req, res } = createMockReqRes({
      token,
      params: { jobId: createdJobId },
      query: { results: 'DELIVERABLE' }
    });

    await exportResults(req, res);
    assert.strictEqual(res.statusCode, 200);

    const csv = String(res.data);
    const lines = csv.split('\r\n').filter(Boolean);
    assert.strictEqual(lines.length, 2); // Header + 1 deliverable

    assert.ok(csv.includes('vikram.deliverable@google.com'));
    assert.ok(!csv.includes('ananya.catchall@google.com'));
    assert.ok(!csv.includes('kabir.undeliverable@google.com'));
  });

  // 8. VERIFY CLEAN-LIST CREATION FROM PERSISTED RESULTS
  console.log('\n[5] Clean List & Update List from Persisted DB Results:');

  let cleanListId: string = '';

  await test('Creates Clean List from persisted PostgreSQL results without altering original list', async () => {
    const { req, res } = createMockReqRes({
      token,
      params: { jobId: createdJobId },
      body: {
        name: 'Persisted Clean Deliverables',
        statuses: ['DELIVERABLE']
      }
    });

    await createCleanList(req, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.data.contactCount, 1);
    cleanListId = res.data.listId;

    // Verify clean list in PostgreSQL
    const cleanMembers = await prisma.listMember.findMany({
      where: { listId: cleanListId }
    });
    assert.strictEqual(cleanMembers.length, 1);
    assert.strictEqual(cleanMembers[0]?.contactId, contact1.id);

    // Verify original list in PostgreSQL remains completely untouched (3 members)
    const origMembers = await prisma.listMember.findMany({
      where: { listId: testList.id }
    });
    assert.strictEqual(origMembers.length, 3);
  });

  await test('Updates original list memberships directly from persisted PostgreSQL results', async () => {
    const { req, res } = createMockReqRes({
      token,
      params: { jobId: createdJobId },
      body: {
        statuses: ['DELIVERABLE', 'CATCH_ALL']
      }
    });

    await updateList(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.keptCount, 2);
    assert.strictEqual(res.data.removedCount, 1);

    // Verify original list in PostgreSQL now has exactly the 2 kept contacts
    const updatedMembers = await prisma.listMember.findMany({
      where: { listId: testList.id }
    });
    assert.strictEqual(updatedMembers.length, 2);
    const memberContactIds = updatedMembers.map(m => m.contactId);
    assert.ok(memberContactIds.includes(contact1.id));
    assert.ok(memberContactIds.includes(contact2.id));
    assert.ok(!memberContactIds.includes(contact3.id)); // Undeliverable removed
  });

  // 9. CLEANUP
  console.log('\n[6] Cleaning up test records in listguard_test_db...');
  setTestSmtpMockHandler(null);

  if (cleanListId) {
    await prisma.listMember.deleteMany({ where: { listId: cleanListId } }).catch(() => {});
    await prisma.list.delete({ where: { id: cleanListId } }).catch(() => {});
  }
  await prisma.emailVerificationResult.deleteMany({ where: { jobId: createdJobId } }).catch(() => {});
  await prisma.emailVerificationJob.deleteMany({ where: { id: createdJobId } }).catch(() => {});
  await prisma.listMember.deleteMany({ where: { listId: testList.id } }).catch(() => {});
  await prisma.list.delete({ where: { id: testList.id } }).catch(() => {});
  await prisma.contactEmail.deleteMany({ where: { contactId: { in: [contact1.id, contact2.id, contact3.id] } } }).catch(() => {});
  await prisma.contact.deleteMany({ where: { id: { in: [contact1.id, contact2.id, contact3.id] } } }).catch(() => {});
  await prisma.workspace.deleteMany({ where: { id: workspace.id } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => {});

  await prisma.$disconnect();

  // Clean up checkDb scratch script if exists
  console.log(`\n====================================================`);
  console.log(`LISTGUARD PERSISTENCE TESTS: ${passed}/${total} PASSED`);
  console.log(`====================================================`);
}

runListGuardPersistenceTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Persistence test failed:', err);
    process.exit(1);
  });
