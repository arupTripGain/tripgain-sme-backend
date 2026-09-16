import assert from 'assert';
import jwt from 'jsonwebtoken';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'tripgain_kinetic_super_secret_jwt_key_2026';

const BASE_URL = 'http://localhost:3001/api/lead-intelligence';

async function runE2eChecks() {
  console.log('🧪 Starting E2E Local API Checks on port 3001...\n');

  // Ensure test user exists in database
  const user = await prisma.user.upsert({
    where: { email: 'e2e_tester@tripgain.com' },
    update: {},
    create: {
      email: 'e2e_tester@tripgain.com',
      name: 'E2E Tester',
      role: 'ADMIN',
    },
  });

  // Clean prior E2E test data
  await prisma.leadIntelligenceLead.deleteMany({ where: { userId: user.id } });
  await prisma.leadIntelligenceRawRecord.deleteMany({ where: { userId: user.id } });
  await prisma.leadIntelligenceSource.deleteMany({ where: { userId: user.id } });

  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    },
    JWT_SECRET
  );

  // 1. Test Pasted Text Ingestion
  console.log('1. Testing Pasted Text Ingestion...');
  const pastedRes = await fetch(`${BASE_URL}/sources/pasted-text`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: "Company\tContact\tEmail\tPhone\tCity\nNexus Logistics\tAlex Rivera\talex@nexuslogistics.com\t+15551239999\tDallas\nHorizon Travel\tElena Gomez\telena@horizontravel.com\t+15559871111\tAustin",
      sourceName: "E2E Pasted Batch",
    }),
  });

  const pastedData = await pastedRes.json();
  console.log('   Pasted text response:', pastedRes.status, pastedData.status, pastedData.stats);
  assert.strictEqual(pastedRes.status, 201);
  assert.strictEqual(pastedData.success, true);
  assert.strictEqual(pastedData.stats.valid, 2);

  // 2. Test Deduplication with exact duplicate
  console.log('\n2. Testing Duplicate Detection with repeated lead...');
  const dupRes = await fetch(`${BASE_URL}/sources/pasted-text`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: "Company\tEmail\nNexus Logistics\talex@nexuslogistics.com",
      sourceName: "E2E Duplicate Batch",
    }),
  });
  const dupData = await dupRes.json();
  console.log('   Duplicate test response:', dupRes.status, dupData.stats);
  assert.strictEqual(dupRes.status, 201);
  assert.strictEqual(dupData.stats.duplicates, 1);

  // 3. Test File Upload (Multipart Form-Data for CSV)
  console.log('\n3. Testing Multipart CSV Upload...');
  const csvBuffer = Buffer.from("Organization,Full Name,Email Address,HQ City\nDelta Software,Marcus Vance,marcus@deltasoftware.io,Denver\nEcho Dynamics,Rachel Green,rachel@echodynamics.com,Seattle");
  const blob = new Blob([csvBuffer], { type: 'text/csv' });
  const formData = new FormData();
  formData.append('file', blob, 'sample_leads.csv');
  formData.append('sourceName', 'E2E CSV Upload Batch');

  const uploadRes = await fetch(`${BASE_URL}/sources/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    body: formData,
  });
  const uploadData = await uploadRes.json();
  console.log('   Upload response:', uploadRes.status, uploadData.stats);
  assert.strictEqual(uploadRes.status, 201);
  assert.strictEqual(uploadData.stats.valid, 2);

  // 4. Test Excel Workbook Upload (XLSX)
  console.log('\n4. Testing Multipart XLSX Upload...');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Company', 'Contact', 'Email', 'City'],
    ['Titan Enterprises', 'David Clark', 'david@titanent.com', 'Phoenix'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const xlsxBlob = new Blob([xlsxBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const xlsxFormData = new FormData();
  xlsxFormData.append('file', xlsxBlob, 'sample_excel.xlsx');
  xlsxFormData.append('sourceName', 'E2E Excel Batch');

  const xlsxRes = await fetch(`${BASE_URL}/sources/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    body: xlsxFormData,
  });
  const xlsxData = await xlsxRes.json();
  console.log('   XLSX response:', xlsxRes.status, xlsxData.stats);
  assert.strictEqual(xlsxRes.status, 201);
  assert.strictEqual(xlsxData.stats.valid, 1);

  // 5. Test Leads Query & Filters
  console.log('\n5. Testing Leads Search & Filter Endpoints...');
  const leadsRes = await fetch(`${BASE_URL}/leads?search=Nexus`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const leadsData = await leadsRes.json();
  console.log('   Search "Nexus":', leadsData.counts);
  assert.strictEqual(leadsRes.status, 200);
  assert.ok(leadsData.leads.length >= 1);
  assert.strictEqual(leadsData.leads[0].companyName, 'Nexus Logistics');

  // 6. Test CSV Export Endpoint
  console.log('\n6. Testing CSV Export Endpoint...');
  const exportRes = await fetch(`${BASE_URL}/export`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  assert.strictEqual(exportRes.status, 200);
  assert.ok(exportRes.headers.get('content-type')?.includes('text/csv'));
  const exportedCsv = await exportRes.text();
  assert.ok(exportedCsv.includes('Nexus Logistics'));
  assert.ok(exportedCsv.includes('Delta Software'));
  console.log('   Exported CSV verified! Length:', exportedCsv.length, 'bytes');

  console.log('\n🎉 ALL LOCAL E2E API VERIFICATION CHECKS PASSED SUCCESSFULLY!\n');
}

runE2eChecks().catch((err) => {
  console.error('❌ E2E Check Failed:', err);
  process.exit(1);
});
