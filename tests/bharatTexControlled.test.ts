import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { extractFromWebsite } from '../src/services/leadIntelligence/extractionService';
import { closeBrowser } from '../src/services/leadIntelligence/playwrightService';

async function testControlledBharatTex() {
  console.log('\n======================================================');
  console.log('🌐 RUNNING CONTROLLED BHARAT TEX LIVE DIRECTORY TEST');
  console.log('======================================================\n');
  const startTime = Date.now();

  try {
    const result = await extractFromWebsite('https://bharat-tex.com/pre-fair-directory/', 'Bharat Tex 2026 Controlled Test', {
      mode: 'all',
      maxPages: 100, // Live directory has ~80 pages
      maxRecords: 5000,
      maxRequests: 10000,
      onProgress: (p: any) => {
        if (p.pagesProcessed % 10 === 0 || p.pagesProcessed === p.totalPages) {
          console.log(`[Progress] Pages: ${p.pagesProcessed}/${p.totalPages || '?'} | Records: ${p.recordsProcessed} | Requests: ${p.requestsMade}`);
        }
      }
    });

    console.log('\n======================================================');
    console.log('🎯 BHARAT TEX CONTROLLED TEST RESULTS');
    console.log('======================================================');
    console.log(`Status:               ${result.status}`);
    console.log(`Pages Discovered:     ${result.metrics.totalPages || result.metrics.pagesProcessed}`);
    console.log(`Pages Processed:      ${result.metrics.pagesProcessed}`);
    console.log(`Records Discovered:   ${result.metrics.recordsDiscovered}`);
    console.log(`Records Processed:    ${result.leads.length}`);
    console.log(`Unique Records:       ${result.metrics.uniqueRecords}`);
    console.log(`Duplicates:           ${result.metrics.duplicates}`);
    console.log(`Failed Records:       ${result.metrics.failedPages}`);
    console.log(`Requests Made:        ${result.metrics.requestsMade}`);
    console.log(`Strategy:             ${result.metrics.strategy}`);
    console.log(`Stop Reason:          ${result.metrics.stopReason || 'Natural completion'}`);
    console.log('======================================================\n');

    if (result.leads.length > 20) {
      console.log(`✅ SUCCESS: Engine successfully traversed beyond page 1 (20 records)! Ingested ${result.leads.length} records across ${result.metrics.pagesProcessed} pages.`);
    } else {
      console.log(`❌ FAILURE: Only ${result.leads.length} records extracted. Did not paginate.`);
    }

  } catch (err: any) {
    console.error('Controlled test error:', err);
  } finally {
    await closeBrowser();
    console.log(`Elapsed time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    process.exit(0);
  }
}

testControlledBharatTex();
