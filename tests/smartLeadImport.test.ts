import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../src/middleware/authMiddleware';
import { parseLeadDeterministic, normalizeUrl } from '../src/services/smartLeadParser';
import { smartParseLead, smartAddLead } from '../src/controllers/smartLeadController';

const prisma = new PrismaClient();

async function runAllTests() {
  console.log('====================================================');
  console.log('STARTING SMART LEAD IMPORT & QUICK ADD TEST SUITE');
  console.log('====================================================');

  // Setup test user and token
  const testUserEmail = `smart_import_test_${Date.now()}@tripgain.com`;
  const user = await prisma.user.create({
    data: { email: testUserEmail, name: 'Smart Import Tester' }
  });

  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET);

  const createMockReq = (body: any) => ({
    body,
    headers: { authorization: `Bearer ${token}` }
  } as any);

  const createMockRes = () => {
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
    // ----------------------------------------------------
    // TEST 1: Email + name + title + LinkedIn + website
    // ----------------------------------------------------
    console.log('\n--- TEST 1: Email + name + title + LinkedIn + website ---');
    const input1 = `vikram@referrush.com
Vikram Pai
Founder & CEO, ReferRush
https://www.linkedin.com/in/vikram-a-pai/?isSelfProfile=false
https://www.referrush.com/`;

    const res1 = parseLeadDeterministic(input1);
    if (!res1.success) throw new Error(`Test 1 parsing failed: ${res1.error}`);
    if (res1.parsed.email !== 'vikram@referrush.com') throw new Error(`Expected email vikram@referrush.com, got ${res1.parsed.email}`);
    if (res1.parsed.firstName !== 'Vikram') throw new Error(`Expected firstName Vikram, got ${res1.parsed.firstName}`);
    if (res1.parsed.lastName !== 'Pai') throw new Error(`Expected lastName Pai, got ${res1.parsed.lastName}`);
    if (res1.parsed.fullName !== 'Vikram Pai') throw new Error(`Expected fullName Vikram Pai, got ${res1.parsed.fullName}`);
    if (res1.parsed.jobTitle !== 'Founder & CEO') throw new Error(`Expected jobTitle Founder & CEO, got ${res1.parsed.jobTitle}`);
    if (res1.parsed.companyName !== 'ReferRush') throw new Error(`Expected companyName ReferRush, got ${res1.parsed.companyName}`);
    if (res1.parsed.linkedinUrl !== 'https://www.linkedin.com/in/vikram-a-pai') throw new Error(`Expected clean linkedinUrl, got ${res1.parsed.linkedinUrl}`);
    if (res1.parsed.websiteUrl !== 'https://www.referrush.com') throw new Error(`Expected clean websiteUrl, got ${res1.parsed.websiteUrl}`);
    console.log('✔ TEST 1 Passed: Successfully parsed complete lead with all 5 fields.');

    // ----------------------------------------------------
    // TEST 2: Different ordering of fields
    // ----------------------------------------------------
    console.log('\n--- TEST 2: Different ordering of fields ---');
    const input2 = `https://www.referrush.com/
Founder & CEO, ReferRush
https://www.linkedin.com/in/vikram-a-pai/?utm_source=feed
vikram@referrush.com
Vikram Pai`;

    const res2 = parseLeadDeterministic(input2);
    if (!res2.success) throw new Error(`Test 2 parsing failed: ${res2.error}`);
    if (res2.parsed.email !== 'vikram@referrush.com') throw new Error(`Expected email vikram@referrush.com, got ${res2.parsed.email}`);
    if (res2.parsed.fullName !== 'Vikram Pai') throw new Error(`Expected fullName Vikram Pai, got ${res2.parsed.fullName}`);
    if (res2.parsed.jobTitle !== 'Founder & CEO') throw new Error(`Expected jobTitle Founder & CEO, got ${res2.parsed.jobTitle}`);
    if (res2.parsed.companyName !== 'ReferRush') throw new Error(`Expected companyName ReferRush, got ${res2.parsed.companyName}`);
    if (res2.parsed.linkedinUrl !== 'https://www.linkedin.com/in/vikram-a-pai') throw new Error(`Expected clean linkedinUrl, got ${res2.parsed.linkedinUrl}`);
    console.log('✔ TEST 2 Passed: Order invariance verified.');

    // ----------------------------------------------------
    // TEST 3: Email only
    // ----------------------------------------------------
    console.log('\n--- TEST 3: Email only ---');
    const input3 = `vikram@referrush.com`;
    const res3 = parseLeadDeterministic(input3);
    if (!res3.success) throw new Error(`Test 3 failed: ${res3.error}`);
    if (res3.parsed.email !== 'vikram@referrush.com') throw new Error(`Expected email vikram@referrush.com, got ${res3.parsed.email}`);
    if (res3.fieldStatus.email !== 'DETECTED') throw new Error(`Expected email status DETECTED, got ${res3.fieldStatus.email}`);
    if (res3.fieldStatus.name !== 'NOT_FOUND') throw new Error(`Expected name status NOT_FOUND, got ${res3.fieldStatus.name}`);
    console.log('✔ TEST 3 Passed: Successfully parsed email-only lead.');

    // ----------------------------------------------------
    // TEST 4: Name + company + email
    // ----------------------------------------------------
    console.log('\n--- TEST 4: Name + company + email ---');
    const input4 = `Vikram Pai
ReferRush
vikram@referrush.com`;
    const res4 = parseLeadDeterministic(input4);
    if (!res4.success) throw new Error(`Test 4 failed: ${res4.error}`);
    if (res4.parsed.fullName !== 'Vikram Pai') throw new Error(`Expected name Vikram Pai, got ${res4.parsed.fullName}`);
    if (res4.parsed.companyName !== 'ReferRush') throw new Error(`Expected company ReferRush, got ${res4.parsed.companyName}`);
    if (res4.parsed.email !== 'vikram@referrush.com') throw new Error(`Expected email vikram@referrush.com, got ${res4.parsed.email}`);
    if (res4.fieldStatus.jobTitle !== 'NOT_FOUND') throw new Error(`Expected jobTitle NOT_FOUND, got ${res4.fieldStatus.jobTitle}`);
    console.log('✔ TEST 4 Passed: Name + company + email parsed correctly.');

    // ----------------------------------------------------
    // TEST 5: LinkedIn before email
    // ----------------------------------------------------
    console.log('\n--- TEST 5: LinkedIn before email ---');
    const input5 = `https://www.linkedin.com/in/vikram-a-pai/
vikram@referrush.com
Vikram Pai
Founder & CEO at ReferRush`;
    const res5 = parseLeadDeterministic(input5);
    if (!res5.success) throw new Error(`Test 5 failed: ${res5.error}`);
    if (res5.parsed.linkedinUrl !== 'https://www.linkedin.com/in/vikram-a-pai') throw new Error(`Expected clean linkedin, got ${res5.parsed.linkedinUrl}`);
    if (res5.parsed.email !== 'vikram@referrush.com') throw new Error(`Expected email, got ${res5.parsed.email}`);
    if (res5.parsed.jobTitle !== 'Founder & CEO') throw new Error(`Expected title Founder & CEO, got ${res5.parsed.jobTitle}`);
    if (res5.parsed.companyName !== 'ReferRush') throw new Error(`Expected company ReferRush, got ${res5.parsed.companyName}`);
    console.log('✔ TEST 5 Passed: LinkedIn before email parsed properly.');

    // ----------------------------------------------------
    // TEST 6: Website before name
    // ----------------------------------------------------
    console.log('\n--- TEST 6: Website before name ---');
    const input6 = `https://www.referrush.com
Vikram Pai
CEO, ReferRush
vikram@referrush.com`;
    const res6 = parseLeadDeterministic(input6);
    if (!res6.success) throw new Error(`Test 6 failed: ${res6.error}`);
    if (res6.parsed.websiteUrl !== 'https://www.referrush.com') throw new Error(`Expected website, got ${res6.parsed.websiteUrl}`);
    if (res6.parsed.fullName !== 'Vikram Pai') throw new Error(`Expected name Vikram Pai, got ${res6.parsed.fullName}`);
    if (res6.parsed.jobTitle !== 'CEO') throw new Error(`Expected title CEO, got ${res6.parsed.jobTitle}`);
    console.log('✔ TEST 6 Passed: Website before name handled cleanly.');

    // ----------------------------------------------------
    // TEST 7: Job title containing company name
    // ----------------------------------------------------
    console.log('\n--- TEST 7: Job title containing company name ---');
    const input7 = `Vikram Pai
ReferRush Founder & CEO
vikram@referrush.com`;
    const res7 = parseLeadDeterministic(input7);
    if (!res7.success) throw new Error(`Test 7 failed: ${res7.error}`);
    if (res7.parsed.companyName !== 'ReferRush') throw new Error(`Expected company ReferRush, got ${res7.parsed.companyName}`);
    if (!res7.parsed.jobTitle?.includes('Founder & CEO')) throw new Error(`Expected jobTitle to include Founder & CEO, got ${res7.parsed.jobTitle}`);
    console.log('✔ TEST 7 Passed: Job title containing company name separated cleanly.');

    // ----------------------------------------------------
    // TEST 8: Company name containing commas
    // ----------------------------------------------------
    console.log('\n--- TEST 8: Company name containing commas ---');
    const input8 = `Vikram Pai
Founder & CEO, ReferRush, Inc.
vikram@referrush.com`;
    const res8 = parseLeadDeterministic(input8);
    if (!res8.success) throw new Error(`Test 8 failed: ${res8.error}`);
    if (res8.parsed.jobTitle !== 'Founder & CEO') throw new Error(`Expected title Founder & CEO, got ${res8.parsed.jobTitle}`);
    if (res8.parsed.companyName !== 'ReferRush, Inc.') throw new Error(`Expected company ReferRush, Inc., got ${res8.parsed.companyName}`);
    console.log('✔ TEST 8 Passed: Company name with legal comma handled correctly.');

    // ----------------------------------------------------
    // TEST 9: Tracking parameters on LinkedIn
    // ----------------------------------------------------
    console.log('\n--- TEST 9: Tracking parameters on LinkedIn ---');
    const input9 = `https://www.linkedin.com/in/vikram-a-pai/?isSelfProfile=false&utm_source=share&utm_medium=member_desktop&ref=test
Vikram Pai
vikram@referrush.com`;
    const res9 = parseLeadDeterministic(input9);
    if (!res9.success) throw new Error(`Test 9 failed: ${res9.error}`);
    if (res9.parsed.linkedinUrl !== 'https://www.linkedin.com/in/vikram-a-pai') {
      throw new Error(`Expected stripped tracking params, got: ${res9.parsed.linkedinUrl}`);
    }
    console.log('✔ TEST 9 Passed: Tracking parameters successfully stripped from LinkedIn URL.');

    // ----------------------------------------------------
    // TEST 10: Existing contact duplicate detection
    // ----------------------------------------------------
    console.log('\n--- TEST 10: Existing contact duplicate detection ---');
    // First, save a contact
    const addReq1 = createMockReq({
      lead: {
        firstName: 'Vikram',
        lastName: 'Pai',
        fullName: 'Vikram Pai',
        email: 'vikram@referrush.com',
        jobTitle: 'Founder & CEO',
        companyName: 'ReferRush',
        linkedinUrl: 'https://www.linkedin.com/in/vikram-a-pai',
        websiteUrl: 'https://www.referrush.com'
      }
    });
    const addRes1 = createMockRes();
    await smartAddLead(addReq1, addRes1);
    if (addRes1.statusCode !== 201) throw new Error(`Expected 201 on first creation, got ${addRes1.statusCode}`);
    if (addRes1.data.isExisting !== false) throw new Error('Expected isExisting: false');
    console.log('Created initial contact ID:', addRes1.data.contact.id);

    // Now, run parse on same text to test duplicate detection
    const parseReq1 = createMockReq({
      text: `vikram@referrush.com\nVikram Pai\nFounder & CEO, ReferRush`
    });
    const parseRes1 = createMockRes();
    await smartParseLead(parseReq1, parseRes1);
    if (parseRes1.statusCode !== 200) throw new Error(`Expected 200, got ${parseRes1.statusCode}`);
    if (!parseRes1.data.duplicate.isDuplicate) throw new Error('Expected duplicate.isDuplicate: true');
    if (parseRes1.data.duplicate.reason !== 'EXACT_EMAIL') throw new Error(`Expected EXACT_EMAIL, got ${parseRes1.data.duplicate.reason}`);
    if (parseRes1.data.duplicate.contactId !== addRes1.data.contact.id) throw new Error('Contact ID mismatch');
    console.log('✔ TEST 10 Passed: Duplicate contact detected accurately via exact email.');

    // ----------------------------------------------------
    // TEST 11: Existing contact + new list
    // ----------------------------------------------------
    console.log('\n--- TEST 11: Existing contact + new list ---');
    const newListName11 = `Global ChemShow ${Date.now()}`;
    const addReq11 = createMockReq({
      lead: {
        email: 'vikram@referrush.com',
        fullName: 'Vikram Pai'
      },
      newListName: newListName11
    });
    const addRes11 = createMockRes();
    await smartAddLead(addReq11, addRes11);
    if (addRes11.statusCode !== 200) throw new Error(`Expected 200 for existing contact, got ${addRes11.statusCode}`);
    if (addRes11.data.isExisting !== true) throw new Error('Expected isExisting: true');
    if (!addRes11.data.lists.includes(newListName11)) throw new Error(`Expected membership in ${newListName11}`);

    // Verify contact ID remained the same (no duplicate created!)
    if (addRes11.data.contact.id !== addRes1.data.contact.id) throw new Error('Duplicate contact was wrongly created!');
    console.log('✔ TEST 11 Passed: Existing contact added to new list without duplication.');

    // ----------------------------------------------------
    // TEST 12: New list creation
    // ----------------------------------------------------
    console.log('\n--- TEST 12: New list creation ---');
    const newListName12 = `Pharma Leaders Expo ${Date.now()}`;
    const addReq12 = createMockReq({
      lead: {
        firstName: 'Ananya',
        lastName: 'Deshmukh',
        fullName: 'Ananya Deshmukh',
        email: 'ananya@biotech.in',
        jobTitle: 'VP of R&D',
        companyName: 'BioTech India'
      },
      newListName: newListName12
    });
    const addRes12 = createMockRes();
    await smartAddLead(addReq12, addRes12);
    if (addRes12.statusCode !== 201) throw new Error(`Expected 201, got ${addRes12.statusCode}`);
    if (!addRes12.data.lists.includes(newListName12)) throw new Error('List not found in returned lists');
    
    // Check DB list existence
    const dbList = await prisma.list.findFirst({
      where: { userId: user.id, name: newListName12 }
    });
    if (!dbList) throw new Error('List was not created in database');
    console.log('✔ TEST 12 Passed: New list created and contact assigned successfully.');

    // ----------------------------------------------------
    // TEST 13: Multiple lists
    // ----------------------------------------------------
    console.log('\n--- TEST 13: Multiple lists ---');
    // Create two separate lists
    const listA = await prisma.list.create({
      data: { name: `List Alpha ${Date.now()}`, listType: 'static', workspaceId: dbList.workspaceId, userId: user.id }
    });
    const listB = await prisma.list.create({
      data: { name: `List Beta ${Date.now()}`, listType: 'static', workspaceId: dbList.workspaceId, userId: user.id }
    });

    const addReq13 = createMockReq({
      lead: {
        firstName: 'Rohan',
        lastName: 'Mehta',
        fullName: 'Rohan Mehta',
        email: 'rohan@alphabeta.com',
        companyName: 'AlphaBeta Systems'
      },
      listIds: [listA.id, listB.id]
    });
    const addRes13 = createMockRes();
    await smartAddLead(addReq13, addRes13);
    if (addRes13.statusCode !== 201) throw new Error(`Expected 201, got ${addRes13.statusCode}`);
    if (addRes13.data.lists.length !== 2) throw new Error(`Expected 2 lists, got ${addRes13.data.lists.length}`);
    console.log('✔ TEST 13 Passed: Lead added to multiple lists simultaneously.');

    // ----------------------------------------------------
    // TEST 14: Duplicate list name
    // ----------------------------------------------------
    console.log('\n--- TEST 14: Duplicate list name normalization ---');
    const existingListCountBefore = await prisma.list.count({
      where: { userId: user.id, name: { equals: listA.name, mode: 'insensitive' } }
    });
    if (existingListCountBefore !== 1) throw new Error('Expected 1 list initially');

    // Add lead with variation in casing and spacing
    const addReq14 = createMockReq({
      lead: {
        firstName: 'Sameer',
        lastName: 'Joshi',
        fullName: 'Sameer Joshi',
        email: 'sameer@joshi.com'
      },
      newListName: `  ${listA.name.toLowerCase()}  `
    });
    const addRes14 = createMockRes();
    await smartAddLead(addReq14, addRes14);
    if (addRes14.statusCode !== 201) throw new Error(`Expected 201, got ${addRes14.statusCode}`);

    const existingListCountAfter = await prisma.list.count({
      where: { userId: user.id, name: { equals: listA.name, mode: 'insensitive' } }
    });
    if (existingListCountAfter !== 1) throw new Error('Duplicate list was created instead of being reused!');
    console.log('✔ TEST 14 Passed: Duplicate list name normalized and reused cleanly.');

    // ----------------------------------------------------
    // TEST 15: Invalid email
    // ----------------------------------------------------
    console.log('\n--- TEST 15: Invalid email rejection ---');
    const addReq15 = createMockReq({
      lead: {
        firstName: 'Invalid',
        lastName: 'User',
        email: 'not-a-valid-email'
      }
    });
    const addRes15 = createMockRes();
    await smartAddLead(addReq15, addRes15);
    if (addRes15.statusCode !== 400) throw new Error(`Expected 400 for invalid email, got ${addRes15.statusCode}`);
    console.log('✔ TEST 15 Passed: Invalid email rejected with 400 Bad Request.');

    // ----------------------------------------------------
    // TEST 16: No recognizable information
    // ----------------------------------------------------
    console.log('\n--- TEST 16: No recognizable information ---');
    const res16 = parseLeadDeterministic('---   ...   !!!');
    if (res16.success !== false) throw new Error('Expected parse to fail for unrecognizable information');
    if (!res16.error?.includes('No recognizable')) throw new Error(`Expected recognizable error, got: ${res16.error}`);

    const parseReq16 = createMockReq({ text: '---   ...' });
    const parseRes16 = createMockRes();
    await smartParseLead(parseReq16, parseRes16);
    if (parseRes16.statusCode !== 400) throw new Error(`Expected 400, got ${parseRes16.statusCode}`);
    console.log('✔ TEST 16 Passed: Input with no recognizable info cleanly rejected.');

    // ----------------------------------------------------
    // TEST 17: Missing email (partial lead)
    // ----------------------------------------------------
    console.log('\n--- TEST 17: Missing email ---');
    const input17 = `Vikram Pai
Founder & CEO, ReferRush
https://www.referrush.com/`;
    const res17 = parseLeadDeterministic(input17);
    if (!res17.success) throw new Error(`Test 17 failed: ${res17.error}`);
    if (res17.parsed.email !== null) throw new Error('Email should NOT be fabricated');
    if (res17.fieldStatus.email !== 'NOT_FOUND') throw new Error(`Expected NOT_FOUND for email, got ${res17.fieldStatus.email}`);
    if (res17.parsed.fullName !== 'Vikram Pai') throw new Error('Expected name Vikram Pai');

    // Save lead without email to verify Contact architecture supports it
    const addReq17 = createMockReq({
      lead: {
        firstName: 'Pooja',
        lastName: 'Bhatt',
        fullName: 'Pooja Bhatt',
        companyName: 'Bhatt Productions',
        jobTitle: 'Managing Director'
      }
    });
    const addRes17 = createMockRes();
    await smartAddLead(addReq17, addRes17);
    if (addRes17.statusCode !== 201) throw new Error(`Expected 201, got ${addRes17.statusCode}`);
    if (addRes17.data.contact.email !== null) throw new Error('Fabricated email returned');
    console.log('✔ TEST 17 Passed: Partial lead without email saved without fabricating email.');

    // ----------------------------------------------------
    // TEST 18: Missing LinkedIn
    // ----------------------------------------------------
    console.log('\n--- TEST 18: Missing LinkedIn ---');
    const input18 = `vikram@referrush.com
Vikram Pai
Founder & CEO, ReferRush
https://www.referrush.com/`;
    const res18 = parseLeadDeterministic(input18);
    if (res18.parsed.linkedinUrl !== null) throw new Error('LinkedIn should NOT be invented');
    if (res18.fieldStatus.linkedin !== 'NOT_FOUND') throw new Error('Expected linkedin NOT_FOUND');
    console.log('✔ TEST 18 Passed: Missing LinkedIn parsed cleanly without invention.');

    // ----------------------------------------------------
    // TEST 19: Missing website
    // ----------------------------------------------------
    console.log('\n--- TEST 19: Missing website ---');
    const input19 = `vikram@referrush.com
Vikram Pai
Founder & CEO, ReferRush
https://www.linkedin.com/in/vikram-a-pai`;
    const res19 = parseLeadDeterministic(input19);
    if (res19.parsed.websiteUrl !== null) throw new Error('Website should NOT be invented');
    if (res19.fieldStatus.website !== 'NOT_FOUND') throw new Error('Expected website NOT_FOUND');
    console.log('✔ TEST 19 Passed: Missing website parsed cleanly without invention.');

    // ----------------------------------------------------
    // TEST 20: Same lead imported twice
    // ----------------------------------------------------
    console.log('\n--- TEST 20: Same lead imported twice ---');
    const uniqueEmail20 = `twice_lead_${Date.now()}@domain.com`;
    const lead20 = {
      firstName: 'Twice',
      lastName: 'Imported',
      fullName: 'Twice Imported',
      email: uniqueEmail20,
      jobTitle: 'Director of Growth',
      companyName: 'DoubleCorp'
    };

    // First import
    const addReq20a = createMockReq({ lead: lead20 });
    const addRes20a = createMockRes();
    await smartAddLead(addReq20a, addRes20a);
    if (addRes20a.statusCode !== 201) throw new Error(`Expected 201, got ${addRes20a.statusCode}`);
    if (addRes20a.data.isExisting !== false) throw new Error('Expected first import isExisting: false');
    const initialId = addRes20a.data.contact.id;

    // Second import of same lead
    const addReq20b = createMockReq({ lead: lead20 });
    const addRes20b = createMockRes();
    await smartAddLead(addReq20b, addRes20b);
    if (addRes20b.statusCode !== 200) throw new Error(`Expected 200, got ${addRes20b.statusCode}`);
    if (addRes20b.data.isExisting !== true) throw new Error('Expected second import isExisting: true');
    if (addRes20b.data.contact.id !== initialId) throw new Error('Created duplicate contact on second import!');

    // Check source field stored as SMART_IMPORT
    const dbContact = await prisma.contact.findUnique({
      where: { id: initialId }
    });
    if (dbContact?.source !== 'SMART_IMPORT') {
      throw new Error(`Expected source SMART_IMPORT, got ${dbContact?.source}`);
    }
    console.log('✔ TEST 20 Passed: Second import correctly detected duplicate, reused ID, source = SMART_IMPORT.');

    // ----------------------------------------------------
    // TEST 21: User exact case (City + LinkedIn name fallback + company + email)
    // ----------------------------------------------------
    console.log('\n--- TEST 21: City + LinkedIn name fallback + company + email ---');
    const input21 = `WEBSOL ENERGY SYSTEM LTD.
Kolkata
https://www.websolenergy.com
https://www.linkedin.com/in/rochita-saha-b74382229
rochitasaha2000@gmail.com`;

    const res21 = parseLeadDeterministic(input21);
    if (!res21.success) throw new Error(`Test 21 failed: ${res21.error}`);
    if (res21.parsed.city !== 'Kolkata') throw new Error(`Expected city Kolkata, got ${res21.parsed.city}`);
    if (res21.parsed.firstName === 'Kolkata') throw new Error(`Bug reproduced: city Kolkata was incorrectly assigned as firstName!`);
    if (res21.parsed.fullName !== 'Rochita Saha') throw new Error(`Expected fullName Rochita Saha, got ${res21.parsed.fullName}`);
    if (res21.parsed.companyName !== 'WEBSOL ENERGY SYSTEM LTD.') throw new Error(`Expected company WEBSOL ENERGY SYSTEM LTD., got ${res21.parsed.companyName}`);
    if (res21.parsed.email !== 'rochitasaha2000@gmail.com') throw new Error(`Expected email rochitasaha2000@gmail.com, got ${res21.parsed.email}`);
    if (res21.fieldStatus.city !== 'DETECTED') throw new Error(`Expected city status DETECTED, got ${res21.fieldStatus.city}`);
    console.log('✔ TEST 21 Passed: Kolkata correctly recognized as City, Rochita Saha extracted from LinkedIn slug.');

    // ----------------------------------------------------
    // TEST 22: Ingest lead with city into database via smartAddLead
    // ----------------------------------------------------
    console.log('\n--- TEST 22: Ingest lead with city into database via smartAddLead ---');
    const addReq22 = createMockReq({ lead: res21.parsed });
    const addRes22 = createMockRes();
    await smartAddLead(addReq22, addRes22);
    if (addRes22.statusCode !== 201) throw new Error(`Expected 201, got ${addRes22.statusCode}: ${JSON.stringify(addRes22.data)}`);
    const contact22 = await prisma.contact.findUnique({
      where: { id: addRes22.data.contact.id },
      include: { organization: true }
    });
    if (contact22?.city !== 'Kolkata') throw new Error(`Expected contact.city Kolkata, got ${contact22?.city}`);
    if (contact22?.organization?.city !== 'Kolkata') throw new Error(`Expected organization.city Kolkata, got ${contact22?.organization?.city}`);
    console.log('✔ TEST 22 Passed: City persisted to Contact and Organization records in database.');

    // ----------------------------------------------------
    // TEST 23: Complete lead with Phone Number + City + Email + Name + Title + Company
    // ----------------------------------------------------
    console.log('\n--- TEST 23: Complete lead with Phone Number + City ---');
    const input23 = `khandelwaludyog1962@gmail.com
+91 9876543210
Vikram Pai
Founder & CEO, Khandelwal Udyog
Kolkata
https://kufence.com
https://www.linkedin.com/in/vikram-a-pai`;

    const res23 = parseLeadDeterministic(input23);
    if (!res23.success) throw new Error(`Test 23 failed: ${res23.error}`);
    if (res23.parsed.email !== 'khandelwaludyog1962@gmail.com') throw new Error(`Expected email, got ${res23.parsed.email}`);
    if (res23.parsed.phone !== '+91 9876543210') throw new Error(`Expected phone +91 9876543210, got ${res23.parsed.phone}`);
    if (res23.fieldStatus.phone !== 'DETECTED') throw new Error(`Expected phone status DETECTED, got ${res23.fieldStatus.phone}`);
    if (res23.parsed.city !== 'Kolkata') throw new Error(`Expected city Kolkata, got ${res23.parsed.city}`);
    if (res23.fieldStatus.city !== 'DETECTED') throw new Error(`Expected city status DETECTED, got ${res23.fieldStatus.city}`);
    if (res23.parsed.fullName !== 'Vikram Pai') throw new Error(`Expected fullName Vikram Pai, got ${res23.parsed.fullName}`);
    if (res23.parsed.jobTitle !== 'Founder & CEO') throw new Error(`Expected jobTitle Founder & CEO, got ${res23.parsed.jobTitle}`);
    if (res23.parsed.companyName !== 'Khandelwal Udyog') throw new Error(`Expected companyName Khandelwal Udyog, got ${res23.parsed.companyName}`);
    console.log('✔ TEST 23 Passed: Phone Number and City detected and parsed properly alongside full lead.');

    // ----------------------------------------------------
    // TEST 24: Ingest lead with Phone Number and City via smartAddLead
    // ----------------------------------------------------
    console.log('\n--- TEST 24: Ingest lead with Phone Number and City via smartAddLead ---');
    const uniqueTimestamp24 = Date.now();
    const uniqueEmail24 = `lead_phone_city_${uniqueTimestamp24}@domain.com`;
    const lead24 = {
      ...res23.parsed,
      fullName: `Test Lead ${uniqueTimestamp24}`,
      firstName: 'Test',
      lastName: `Lead ${uniqueTimestamp24}`,
      email: uniqueEmail24,
      linkedinUrl: `https://www.linkedin.com/in/test-lead-${uniqueTimestamp24}`
    };
    const addReq24 = createMockReq({ lead: lead24 });
    const addRes24 = createMockRes();
    await smartAddLead(addReq24, addRes24);
    if (addRes24.statusCode !== 201) throw new Error(`Expected 201, got ${addRes24.statusCode}: ${JSON.stringify(addRes24.data)}`);
    const contact24 = await prisma.contact.findUnique({
      where: { id: addRes24.data.contact.id },
      include: { organization: true }
    });
    if (contact24?.phone !== '+91 9876543210') throw new Error(`Expected contact.phone +91 9876543210, got ${contact24?.phone}`);
    if (contact24?.city !== 'Kolkata') throw new Error(`Expected contact.city Kolkata, got ${contact24?.city}`);
    if (contact24?.organization?.city !== 'Kolkata') throw new Error(`Expected organization.city Kolkata, got ${contact24?.organization?.city}`);
    console.log('✔ TEST 24 Passed: Phone Number and City successfully persisted to database Contact record.');

    console.log('\n====================================================');
    console.log('ALL SMART LEAD IMPORT TESTS PASSED SUCCESSFULLY! 🎉');
    console.log('====================================================');
  } finally {
    await prisma.$disconnect();
  }
}

runAllTests().catch(err => {
  console.error('\n❌ TEST RUNNER FAILED WITH ERROR:', err);
  process.exit(1);
});
