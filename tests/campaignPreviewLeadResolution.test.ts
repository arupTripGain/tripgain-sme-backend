import assert from 'assert';
import dotenv from 'dotenv';
import Handlebars from 'handlebars';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const prisma = new PrismaClient();

// Mirror of frontend VARIABLE_REGISTRY from templateEngine.ts
const VARIABLE_REGISTRY: Record<string, any> = {
  firstName: { tag: '{{firstName}}', required: false, fallback: 'there' },
  lastName: { tag: '{{lastName}}', required: false },
  email: { tag: '{{email}}', required: false },
  title: { tag: '{{title}}', required: false, fallback: 'your role' },
  companyName: { tag: '{{companyName}}', required: true, fallback: 'your company' },
  website: { tag: '{{website}}', required: false },
  industry: { tag: '{{industry}}', required: false },
  companySize: { tag: '{{companySize}}', required: false },
  companyPhone: { tag: '{{companyPhone}}', required: false },
  personLinkedinUrl: { tag: '{{personLinkedinUrl}}', required: false },
  city: { tag: '{{city}}', required: false },
  personalization: { tag: '{{personalization}}', required: false },
  personalizedLine: { tag: '{{personalizedLine}}', required: false },
  senderName: { tag: '{{senderName}}', required: true },
  senderCompany: { tag: '{{senderCompany}}', required: true }
};

export interface CanonicalLeadContext {
  firstName: string;
  lastName: string;
  email: string;
  title: string;
  companyName: string;
  website: string;
  industry: string;
  companySize: string;
  companyPhone: string;
  personLinkedinUrl: string;
  city: string;
  personalization: string;
  personalizedLine: string;
  senderName: string;
  senderCompany: string;
}

import { buildCanonicalLeadContext } from '../src/utils/templateContext';

// Mirror of validateLeadContext from templateEngine.ts
function validateLeadContext(data: Record<string, any>): { isValid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (!data) return { isValid: true, warnings };

  const company = (data.companyName || '').trim();
  const pers = (data.personalization || data.personalizedLine || '').trim();

  // Check 1: Disallow legacy mock/fake companies
  const disallowedMockCompanies = ['acme technologies', 'acme', 'test company', 'example corp'];
  if (disallowedMockCompanies.includes(company.toLowerCase())) {
    warnings.push(`Disallowed mock company detected in preview context: "${company}".`);
  }

  // Check 2: Cross-check personalization text for company name conflict
  if (pers && company) {
    const introMatch = pers.match(/(?:I noticed that|At|I saw that|Following)\s+([A-Z0-9][A-Za-z0-9\s&.\-]{1,30}?)\s+(?:provides|builds|delivers|offers|is|specializes|operates|focuses)/i);
    if (introMatch && introMatch[1]) {
      const referencedCompany = introMatch[1].trim();
      const normRef = referencedCompany.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normComp = company.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normRef.length > 2 && normComp.length > 2 && !normRef.includes(normComp) && !normComp.includes(normRef)) {
        warnings.push(`Potential company mismatch: Personalization mentions "${referencedCompany}" but {{companyName}} resolved to "${company}".`);
      }
    }
  }

  return {
    isValid: warnings.length === 0,
    warnings
  };
}

// Mirror of renderTemplate from templateEngine.ts
function renderTemplate(templateStr: string, data: Record<string, any>): string {
  if (!templateStr) return '';
  const template = Handlebars.compile(templateStr, { noEscape: true });
  const processedData: Record<string, any> = {};

  for (const key of Object.keys(VARIABLE_REGISTRY)) {
    let rawVal = data[key];
    if ((rawVal === undefined || rawVal === null || rawVal.toString().trim() === '') && key === 'personalization') {
      rawVal = data.personalizedLine;
    } else if ((rawVal === undefined || rawVal === null || rawVal.toString().trim() === '') && key === 'personalizedLine') {
      rawVal = data.personalization;
    }

    const isMissing = rawVal === undefined || rawVal === null || rawVal.toString().trim() === '';
    processedData[key] = isMissing ? '' : rawVal;
  }

  for (const key of Object.keys(data)) {
    if (!processedData.hasOwnProperty(key)) {
      const rawVal = data[key];
      processedData[key] = rawVal === undefined || rawVal === null ? '' : rawVal;
    }
  }

  let output = template(processedData);
  output = output.replace(/ {2,}/g, ' ');
  output = output.replace(/ ,/g, ',');
  output = output.replace(/ \./g, '.');
  output = output.replace(/\n{3,}/g, '\n\n');
  return output.trim();
}

async function runTests() {
  console.log('================================================================');
  console.log('   CAMPAIGN PREVIEW LEAD-VARIABLE RESOLUTION TEST SUITE        ');
  console.log('================================================================\n');

  // Verify baseline production safety
  const initialEmailCount = await prisma.emailMessage.count();
  const initialEnrollmentCount = await prisma.enrollment.count();
  const initialCampaignCount = await prisma.campaign.count();
  console.log(`[Safety Baseline] EmailMessage records: ${initialEmailCount}`);
  console.log(`[Safety Baseline] Enrollment records: ${initialEnrollmentCount}`);
  console.log(`[Safety Baseline] Campaign records: ${initialCampaignCount}\n`);

  // Production campaign step template
  const subjectTemplate = "{{firstName}}, one operational task to simplify as {{companyName}} grows";
  const bodyTemplate = "Hi {{firstName}},\n\n{{personalization}}\n\nAs {{companyName}} grows, business travel, employee expenses, invoices, and approvals can quickly become another operational task.\n\nI work with TripGain, where we help growing teams manage business travel along with travel and non-travel expenses in one place.\n\nIs this something {{companyName}} currently manages internally, or through a travel partner?\n\nBest,\n{{senderName}}\n{{senderCompany}}";

  // ----------------------------------------------------
  // TEST MATRIX: 5 REAL CONTACTS FROM DIFFERENT COMPANIES
  // ----------------------------------------------------
  console.log('--- TEST 1: 5 Real Contacts Variable Resolution Matrix ---');
  
  // Specifically look for Zubin Jagtiani first
  const zubinContact = await prisma.contact.findFirst({
    where: { firstName: 'Zubin' },
    include: { organization: true, emails: true }
  });

  const allContacts = await prisma.contact.findMany({
    take: 30,
    orderBy: { createdAt: 'desc' },
    include: { organization: true, emails: true }
  });

  const testLeads: any[] = [];
  const seenCompanies = new Set<string>();

  if (zubinContact && zubinContact.organization?.name) {
    seenCompanies.add(zubinContact.organization.name);
    testLeads.push({
      id: zubinContact.id,
      fullName: zubinContact.fullName,
      firstName: zubinContact.firstName,
      lastName: zubinContact.lastName,
      email: zubinContact.emails[0]?.email || '',
      jobTitle: zubinContact.jobTitle,
      city: zubinContact.city,
      companyName: zubinContact.organization.name, // Returned by /api/contacts
      organization: undefined,                     // Emulate flattened /api/contacts response
      personalizedLine: zubinContact.personalizedLine,
      personalization: zubinContact.personalizedLine
    });
  }

  for (const c of allContacts) {
    const comp = c.organization?.name;
    if (comp && !seenCompanies.has(comp)) {
      seenCompanies.add(comp);
      testLeads.push({
        id: c.id,
        fullName: c.fullName,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.emails[0]?.email || '',
        jobTitle: c.jobTitle,
        city: c.city,
        companyName: c.organization?.name,
        organization: undefined,
        personalizedLine: c.personalizedLine,
        personalization: c.personalizedLine
      });
    }
    if (testLeads.length === 5) break;
  }

  assert.strictEqual(testLeads.length, 5, 'Must have 5 distinct company contacts');

  for (let i = 0; i < testLeads.length; i++) {
    const lead = testLeads[i];
    const context = buildCanonicalLeadContext(lead, 'Arup Nirala', 'TripGain');

    const renderedSubject = renderTemplate(subjectTemplate, context);
    const renderedBody = renderTemplate(bodyTemplate, context);

    console.log(`\n[Lead ${i + 1}]: ${context.firstName} ${context.lastName} (${context.companyName})`);
    console.log(`  - firstName:        ${context.firstName}`);
    console.log(`  - lastName:         ${context.lastName}`);
    console.log(`  - email:            ${context.email}`);
    console.log(`  - title:            ${context.title}`);
    console.log(`  - companyName:      ${context.companyName}`);
    console.log(`  - city:             ${context.city}`);
    console.log(`  - personalization:  ${(context.personalization || '').slice(0, 40)}...`);
    console.log(`  - personalizedLine: ${(context.personalizedLine || '').slice(0, 40)}...`);
    console.log(`  - Subject:          "${renderedSubject}"`);
    console.log(`  - Body excerpt:     "${renderedBody.slice(0, 100).replace(/\n/g, ' ')}..."`);

    // Verification 1: zero Acme Technologies or mock values
    assert(!renderedSubject.includes('Acme Technologies'), `Lead ${i + 1} Subject must not contain Acme Technologies`);
    assert(!renderedBody.includes('Acme Technologies'), `Lead ${i + 1} Body must not contain Acme Technologies`);
    assert(!renderedSubject.includes('Test Company'), `Lead ${i + 1} Subject must not contain Test Company`);

    // Verification 2: rendered company name matches selected contact
    assert(context.companyName.length > 0, 'companyName must not be empty');
    assert(renderedSubject.includes(context.companyName), `Lead ${i + 1} Subject must contain company ${context.companyName}`);
    assert(renderedBody.includes(`As ${context.companyName} grows`), `Lead ${i + 1} Body must contain company ${context.companyName}`);

    // Verification 3: recipient company and sender company are distinct
    assert.strictEqual(context.senderCompany, 'TripGain');
    assert.notStrictEqual(context.companyName, context.senderCompany, 'recipient companyName must not be senderCompany');

    // Specific verification for Zubin
    if (lead.firstName === 'Zubin') {
      console.log('  -> SPECIFIC VERIFICATION FOR ZUBIN JAGTIANI:');
      console.log('  FULL RENDERED BODY:\n', renderedBody);
      assert.strictEqual(context.firstName, 'Zubin');
      assert.strictEqual(context.companyName, 'Think7');
      assert.strictEqual(renderedSubject, 'Zubin, one operational task to simplify as Think7 grows');
      assert(renderedBody.includes('As Think7 grows'), 'Body must say "As Think7 grows"');
      assert(!renderedBody.includes('As Acme Technologies grows'), 'Body must NOT say "As Acme Technologies grows"');
      console.log('  -> [PASS] Zubin renders Think7 exclusively!');
    }
  }

  // ----------------------------------------------------
  // TEST 2: CONDITIONAL VARIABLES WITH & WITHOUT COMPANY
  // ----------------------------------------------------
  console.log('\n--- TEST 2: Conditional Variables ({{#if companyName}}) ---');
  const conditionalTemplate = "{{#if companyName}}{{companyName}}{{else}}your team{{/if}}";

  // Lead with companyName
  const leadWithCompany = { firstName: 'Zubin', companyName: 'Think7' };
  const ctxWith = buildCanonicalLeadContext(leadWithCompany);
  const resWith = renderTemplate(conditionalTemplate, ctxWith);
  console.log(`With companyName ('Think7'): -> "${resWith}"`);
  assert.strictEqual(resWith, 'Think7', 'Must render Think7 when present');

  // Lead without companyName
  const leadWithoutCompany = { firstName: 'Anonymous', companyName: '' };
  const ctxWithout = buildCanonicalLeadContext(leadWithoutCompany);
  const resWithout = renderTemplate(conditionalTemplate, ctxWithout);
  console.log(`Without companyName (''):  -> "${resWithout}"`);
  assert.strictEqual(resWithout, 'your team', 'Must render fallback "your team" when empty');
  assert(!resWithout.includes('Acme'), 'Must never render Acme as fallback');

  // ----------------------------------------------------
  // TEST 3: MULTIPLE PREVIEW SWITCHING & RAPID SWITCHING (A -> B -> A)
  // ----------------------------------------------------
  console.log('\n--- TEST 3: Multiple Preview Switching (A -> B -> A) ---');
  const leadA = {
    firstName: 'Zubin',
    lastName: 'Jagtiani',
    companyName: 'Think7',
    personalization: 'I noticed that Think7 provides ERP software...'
  };

  const leadB = {
    firstName: 'Rahul',
    lastName: 'Sharma',
    companyName: 'Infosys',
    personalization: 'I noticed that Infosys delivers digital services...'
  };

  // State Step 1: Select A
  let activeState = buildCanonicalLeadContext(leadA);
  let subA = renderTemplate(subjectTemplate, activeState);
  let bodyA = renderTemplate(bodyTemplate, activeState);
  assert(subA.includes('Think7') && !subA.includes('Infosys'));
  assert(bodyA.includes('Think7') && !bodyA.includes('Infosys'));

  // State Step 2: Switch to B
  activeState = buildCanonicalLeadContext(leadB);
  let subB = renderTemplate(subjectTemplate, activeState);
  let bodyB = renderTemplate(bodyTemplate, activeState);
  assert(subB.includes('Infosys') && !subB.includes('Think7'));
  assert(bodyB.includes('Infosys') && !bodyB.includes('Think7'));

  // State Step 3: Switch back to A
  activeState = buildCanonicalLeadContext(leadA);
  let subA2 = renderTemplate(subjectTemplate, activeState);
  let bodyA2 = renderTemplate(bodyTemplate, activeState);
  assert(subA2.includes('Think7') && !subA2.includes('Infosys'));
  assert(bodyA2.includes('Think7') && !bodyA2.includes('Infosys'));
  assert(!bodyA2.includes('Acme Technologies'));

  // Rapid switching loop
  for (let i = 0; i < 20; i++) {
    const selected = (i % 2 === 0) ? leadA : leadB;
    const ctx = buildCanonicalLeadContext(selected);
    assert.strictEqual(ctx.firstName, selected.firstName);
    assert.strictEqual(ctx.companyName, selected.companyName);
    assert.strictEqual(ctx.personalization, selected.personalization);
  }
  console.log('[PASS] A -> B -> A switching maintains strict isolation and zero state leakage.');

  // ----------------------------------------------------
  // TEST 4: DEFENSIVE INTEGRITY VALIDATION
  // ----------------------------------------------------
  console.log('\n--- TEST 4: Defensive Lead Context Validation ---');

  // Case 1: Disallowed mock company
  const mockContext = {
    firstName: 'John',
    companyName: 'Acme Technologies',
    personalization: 'Hello there'
  };
  const mockValidation = validateLeadContext(mockContext);
  console.log(`Mock company validation: isValid=${mockValidation.isValid}, warnings=${JSON.stringify(mockValidation.warnings)}`);
  assert.strictEqual(mockValidation.isValid, false);
  assert(mockValidation.warnings.length > 0 && mockValidation.warnings[0]!.includes('Disallowed mock company'));

  // Case 2: Company mismatch (personalization says Think7, companyName says Wipro)
  const mismatchContext = {
    firstName: 'Zubin',
    companyName: 'Wipro',
    personalization: 'I noticed that Think7 provides ERP software focused on manufacturing...'
  };
  const mismatchValidation = validateLeadContext(mismatchContext);
  console.log(`Mismatch validation: isValid=${mismatchValidation.isValid}, warnings=${JSON.stringify(mismatchValidation.warnings)}`);
  assert.strictEqual(mismatchValidation.isValid, false);
  assert(mismatchValidation.warnings.length > 0 && mismatchValidation.warnings[0]!.includes('Potential company mismatch'));

  // Case 3: Valid matched context
  const validContext = {
    firstName: 'Zubin',
    companyName: 'Think7',
    personalization: 'I noticed that Think7 provides ERP software focused on manufacturing...'
  };
  const validValidation = validateLeadContext(validContext);
  console.log(`Valid context validation: isValid=${validValidation.isValid}, warnings=${JSON.stringify(validValidation.warnings)}`);
  assert.strictEqual(validValidation.isValid, true);
  assert.strictEqual(validValidation.warnings.length, 0);

  // ----------------------------------------------------
  // TEST 5: FINAL SAFETY AUDIT
  // ----------------------------------------------------
  console.log('\n--- TEST 5: Final Production Safety Verification ---');
  const finalEmailCount = await prisma.emailMessage.count();
  const finalEnrollmentCount = await prisma.enrollment.count();
  const finalCampaignCount = await prisma.campaign.count();

  console.log(`[Safety Final] EmailMessage records: ${finalEmailCount} (Delta: ${finalEmailCount - initialEmailCount})`);
  console.log(`[Safety Final] Enrollment records: ${finalEnrollmentCount} (Delta: ${finalEnrollmentCount - initialEnrollmentCount})`);
  console.log(`[Safety Final] Campaign records: ${finalCampaignCount} (Delta: ${finalCampaignCount - initialCampaignCount})`);

  assert.strictEqual(finalEmailCount, initialEmailCount, 'Zero emails must be sent!');
  assert.strictEqual(finalEnrollmentCount, initialEnrollmentCount, 'Zero enrollments must be modified!');
  assert.strictEqual(finalCampaignCount, initialCampaignCount, 'Zero campaigns must be created or modified!');

  console.log('\n================================================================');
  console.log('   ALL CAMPAIGN PREVIEW RESOLUTION TESTS PASSED SUCCESSFULLY!   ');
  console.log('================================================================\n');
}

runTests()
  .catch((err) => {
    console.error('Test failed with error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
