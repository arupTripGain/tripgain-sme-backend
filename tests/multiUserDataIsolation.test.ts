import 'dotenv/config';
import assert from 'assert';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { OwnershipGuard } from '../src/utils/ownershipGuard';
import { getContacts, createContact, getContactById } from '../src/controllers/contactController';
import { getCampaigns, getCampaignById } from '../src/controllers/campaignController';
import { getCampaignAnalytics } from '../src/controllers/campaignAnalyticsController';
import { getLists, getListById } from '../src/controllers/listController';
import { getMailboxes, disconnectMailbox } from '../src/controllers/mailboxController';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'tripgain_dev_jwt_secret_change_in_production';

// Helper to build mock Express Request and Response
function createMockReqRes(options: {
  token?: string | null;
  user?: any;
  params?: Record<string, string>;
  query?: Record<string, any>;
  body?: any;
}) {
  let statusCode = 200;
  let responseData: any = null;
  let headersSent = false;

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
      headersSent = true;
      return res;
    },
    send(data: any) {
      responseData = data;
      headersSent = true;
      return res;
    },
    setHeader() {},
    get statusCode() {
      return statusCode;
    },
    get data() {
      return responseData;
    }
  };

  return { req, res };
}

async function runTests() {
  console.log('====================================================');
  console.log('  RUNNING MULTI-USER DATA ISOLATION TEST SUITE');
  console.log('====================================================');

  const ARUP_USER_ID = '07b35148-6de7-4ea4-8702-7b4543764ad6';
  const SARAH_USER_ID = '54e3225e-7b52-4ad6-9ba4-b40107da3a49';

  // 1. Verify users exist in database
  const arupUser = await prisma.user.findUnique({ where: { id: ARUP_USER_ID } });
  const sarahUser = await prisma.user.findUnique({ where: { id: SARAH_USER_ID } });

  assert(arupUser, 'Arup user must exist in DB');
  assert(sarahUser, 'Sarah user must exist in DB');
  console.log(`✔ Found User A: ${arupUser.name} (${arupUser.email}, role: ${arupUser.role})`);
  console.log(`✔ Found User B: ${sarahUser.name} (${sarahUser.email}, role: ${sarahUser.role})`);

  // 2. Generate valid JWT tokens for both users
  const arupToken = jwt.sign(
    { userId: arupUser.id, email: arupUser.email, role: arupUser.role, name: arupUser.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const sarahToken = jwt.sign(
    { userId: sarahUser.id, email: sarahUser.email, role: sarahUser.role, name: sarahUser.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // 3. Test Authentication Guard (401 on missing or invalid token)
  console.log('\n--- 3. Testing OwnershipGuard.requireUser ---');
  {
    const { req, res } = createMockReqRes({ token: null });
    const user = OwnershipGuard.requireUser(req, res);
    assert.strictEqual(user, null, 'Unauthenticated request must return null');
    assert.strictEqual(res.statusCode, 401, 'Unauthenticated request must return 401');
    assert.strictEqual(res.data.error, 'Unauthorized: Access token is missing', 'Error message must match');
    console.log('✔ Reject unauthenticated request with 401');
  }

  {
    const { req, res } = createMockReqRes({ token: 'invalid.token.here' });
    const user = OwnershipGuard.requireUser(req, res);
    assert.strictEqual(user, null, 'Invalid token must return null');
    assert.strictEqual(res.statusCode, 401, 'Invalid token must return 401');
    assert.strictEqual(res.data.error, 'Unauthorized: Invalid or expired token', 'Error message must match');
    console.log('✔ Reject malformed / tampered token with 401');
  }

  {
    const { req, res } = createMockReqRes({ token: arupToken });
    const user = OwnershipGuard.requireUser(req, res);
    assert(user, 'Valid token must resolve user');
    assert.strictEqual(user.userId, ARUP_USER_ID);
    console.log('✔ Successfully authenticate and extract User A from JWT');
  }

  // 4. Test Contacts Isolation
  console.log('\n--- 4. Testing Contacts Isolation ---');
  // Clean up any residual test contact for Sarah to guarantee clean baseline
  const existingSarahContacts = await prisma.contact.findMany({ where: { userId: SARAH_USER_ID }, select: { id: true } });
  if (existingSarahContacts.length > 0) {
    const sIds = existingSarahContacts.map(c => c.id);
    await prisma.listMember.deleteMany({ where: { contactId: { in: sIds } } });
    await prisma.contactEmail.deleteMany({ where: { contactId: { in: sIds } } });
    await prisma.contact.deleteMany({ where: { id: { in: sIds } } });
  }
  let arupContactId: string = '';
  {
    // Arup gets contacts -> should see 14 contacts
    const { req, res } = createMockReqRes({ token: arupToken });
    await getContacts(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert(Array.isArray(res.data), 'Contacts should be an array');
    assert(res.data.length >= 14, `Arup should see at least 14 contacts, got ${res.data.length}`);
    arupContactId = res.data[0].id;
    console.log(`✔ User A (Arup) fetches contacts: saw ${res.data.length} contacts`);
  }

  {
    // Sarah gets contacts -> should see 0 contacts initially
    const { req, res } = createMockReqRes({ token: sarahToken });
    await getContacts(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert(Array.isArray(res.data), 'Contacts should be an array');
    assert.strictEqual(res.data.length, 0, `Sarah must see 0 contacts, got ${res.data.length}`);
    console.log('✔ User B (Sarah) fetches contacts: saw 0 contacts (isolated from User A)');
  }

  let sarahContactId: string = '';
  {
    // Sarah creates a contact -> must be owned by Sarah
    const { req, res } = createMockReqRes({
      token: sarahToken,
      body: {
        firstName: 'SarahLead',
        lastName: 'Test',
        email: 'sarahlead.test@example.com',
        company: 'Sarah Enterprise'
      }
    });
    await createContact(req, res);
    assert.strictEqual(res.statusCode, 201);
    assert(res.data?.id, 'Contact creation must return created contact');
    sarahContactId = res.data.id;
    console.log(`✔ User B (Sarah) created contact: ${sarahContactId}`);

    // Verify DB record directly
    const createdInDb = await prisma.contact.findUnique({ where: { id: sarahContactId } });
    assert.strictEqual(createdInDb?.userId, SARAH_USER_ID, 'Created contact must have userId = Sarah');
  }

  {
    // Sarah fetches contacts again -> should see exactly 1 contact
    const { req, res } = createMockReqRes({ token: sarahToken });
    await getContacts(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.length, 1, `Sarah should now see exactly 1 contact, got ${res.data.length}`);
    assert.strictEqual(res.data[0].id, sarahContactId);
    console.log('✔ User B (Sarah) fetches contacts: saw only her 1 contact');
  }

  {
    // Arup fetches contacts -> must NOT see Sarah's contact
    const { req, res } = createMockReqRes({ token: arupToken });
    await getContacts(req, res);
    assert.strictEqual(res.statusCode, 200);
    const hasSarahContact = res.data.some((c: any) => c.id === sarahContactId);
    assert.strictEqual(hasSarahContact, false, 'Arup must NOT see Sarah contact');
    console.log('✔ User A (Arup) does NOT see Sarah newly created contact (two-way isolation confirmed)');
  }

  // 5. Test Contact IDOR Protection
  console.log('\n--- 5. Testing Contact IDOR Protection ---');
  {
    // Sarah tries to access Arup's contact by ID -> must get 404
    const { req, res } = createMockReqRes({ token: sarahToken, params: { id: arupContactId } });
    await getContactById(req, res);
    assert.strictEqual(res.statusCode, 404, 'Accessing another user contact must return 404');
    assert.strictEqual(res.data.error, 'Contact not found');
    console.log('✔ User B accessing User A contact by UUID returns 404 (IDOR protected)');
  }

  // 6. Test Campaigns Isolation
  console.log('\n--- 6. Testing Campaigns Isolation ---');
  let arupCampaignId: string = '';
  {
    // Arup fetches campaigns -> should see his campaigns
    const { req, res } = createMockReqRes({ token: arupToken });
    await getCampaigns(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert(Array.isArray(res.data));
    assert(res.data.length >= 1, `Arup should see at least 1 campaign, got ${res.data.length}`);
    arupCampaignId = res.data[0].id;
    console.log(`✔ User A (Arup) fetches campaigns: saw ${res.data.length} campaigns`);
  }

  {
    // Sarah fetches campaigns -> should see 0 campaigns
    const { req, res } = createMockReqRes({ token: sarahToken });
    await getCampaigns(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert(Array.isArray(res.data));
    assert.strictEqual(res.data.length, 0, `Sarah must see 0 campaigns, got ${res.data.length}`);
    console.log('✔ User B (Sarah) fetches campaigns: saw 0 campaigns');
  }

  // 7. Test Campaign IDOR Protection
  console.log('\n--- 7. Testing Campaign IDOR Protection ---');
  {
    // Sarah tries to access Arup's campaign details by ID -> must get 404
    const { req, res } = createMockReqRes({ token: sarahToken, params: { id: arupCampaignId } });
    await getCampaignById(req, res);
    assert.strictEqual(res.statusCode, 404, 'Accessing another user campaign must return 404');
    assert.strictEqual(res.data.error, 'Campaign not found');
    console.log('✔ User B accessing User A campaign by UUID returns 404');
  }

  {
    // Sarah tries to access Arup's campaign analytics -> must get 404
    const { req, res } = createMockReqRes({ token: sarahToken, params: { id: arupCampaignId } });
    await getCampaignAnalytics(req, res);
    assert.strictEqual(res.statusCode, 404, 'Accessing another user campaign analytics must return 404');
    assert.strictEqual(res.data.error, 'Campaign not found');
    console.log('✔ User B accessing User A campaign analytics returns 404');
  }

  // 8. Test Lists Isolation & IDOR
  console.log('\n--- 8. Testing Lists Isolation & IDOR ---');
  let arupListId: string = '';
  {
    // Arup fetches lists -> sees his lists + suppression
    const { req, res } = createMockReqRes({ token: arupToken });
    await getLists(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert(res.data.length >= 1, `Arup should see at least 1 list, got ${res.data.length}`);
    const customList = res.data.find((l: any) => l.id !== 'suppression-1');
    arupListId = customList.id;
    console.log(`✔ User A (Arup) fetches lists: saw ${res.data.length} lists`);
  }

  {
    // Sarah fetches lists -> must not see any of Arup's lists
    const { req, res } = createMockReqRes({ token: sarahToken });
    await getLists(req, res);
    assert.strictEqual(res.statusCode, 200);
    const leakedLists = res.data.filter((l: any) => l.id === arupListId);
    assert.strictEqual(leakedLists.length, 0, `Sarah must see 0 lists belonging to User A`);
    console.log('✔ User B (Sarah) fetches lists: saw 0 custom lists from User A');
  }

  {
    // Sarah attempts to access Arup's list by UUID -> must get 404
    const { req, res } = createMockReqRes({ token: sarahToken, params: { id: arupListId } });
    await getListById(req, res);
    assert.strictEqual(res.statusCode, 404, 'Accessing another user list must return 404');
    assert.strictEqual(res.data.error, 'List not found');
    console.log('✔ User B accessing User A list by UUID returns 404');
  }

  // 9. Test Mailboxes Isolation
  console.log('\n--- 9. Testing Mailboxes Isolation ---');
  let arupMailboxId: string = '';
  {
    // Arup fetches mailboxes
    const { req, res } = createMockReqRes({ token: arupToken });
    await getMailboxes(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert(res.data.length >= 4, `Arup should see at least 4 mailboxes, got ${res.data.length}`);
    arupMailboxId = res.data[0].id;
    console.log(`✔ User A (Arup) fetches mailboxes: saw ${res.data.length} mailboxes`);
  }

  {
    // Sarah fetches mailboxes -> sees 0
    const { req, res } = createMockReqRes({ token: sarahToken });
    await getMailboxes(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.length, 0, `Sarah must see 0 mailboxes, got ${res.data.length}`);
    console.log('✔ User B (Sarah) fetches mailboxes: saw 0 mailboxes');
  }

  {
    // Sarah attempts to disconnect Arup's mailbox -> must get 404
    const { req, res } = createMockReqRes({ token: sarahToken, params: { id: arupMailboxId } });
    await disconnectMailbox(req, res);
    assert.strictEqual(res.statusCode, 404, 'Accessing another user mailbox must return 404');
    assert.strictEqual(res.data.error, 'Mailbox not found');
    console.log('✔ User B attempting to mutate User A mailbox returns 404');
  }

  // 10. Clean up Sarah's test contact
  if (sarahContactId) {
    await prisma.contactEmail.deleteMany({ where: { contactId: sarahContactId } });
    await prisma.contact.delete({ where: { id: sarahContactId } });
    console.log('\n✔ Cleaned up test contact created for Sarah');
  }

  console.log('\n====================================================');
  console.log('  ALL 10 MULTI-USER DATA ISOLATION TESTS PASSED! 🎉');
  console.log('====================================================\n');
}

runTests()
  .catch((err) => {
    console.error('TEST RUNNER FAILED:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
