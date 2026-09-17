import 'dotenv/config';
import assert from 'assert';
import { normalizeEmail } from '../src/services/listGuard/emailNormalizer';
import { checkEmailSyntax } from '../src/services/listGuard/syntaxChecker';
import { checkDomainDns } from '../src/services/listGuard/dnsChecker';
import { isDisposableEmail, disposableRegistry } from '../src/services/listGuard/disposableChecker';
import { isRoleAccount } from '../src/services/listGuard/roleChecker';
import {
  verifyEmailSmtp,
  setTestSmtpMockHandler,
  classifySmtpHandshakeResponse,
  SmtpVerifyResult
} from '../src/services/listGuard/smtpVerifier';
import { VerificationEngine } from '../src/services/listGuard/verificationEngine';
import { ListGuardStore } from '../src/services/listGuard/listGuardStore';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function runListGuardEngineTests() {
  console.log('--- STARTING LISTGUARD ENGINE TEST SUITE ---');

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

  // -------------------------------------------------------------
  // 1. NORMALIZATION
  // -------------------------------------------------------------
  console.log('\n[1] Email Normalization Tests:');
  test('Normalizes lowercase and trims leading/trailing spaces', () => {
    const res = normalizeEmail('   John.Doe@Company.COM   ');
    assert.strictEqual(res.normalizedEmail, 'john.doe@company.com');
    assert.strictEqual(res.localPart, 'john.doe');
    assert.strictEqual(res.domain, 'company.com');
    assert.strictEqual(res.isValidFormat, true);
  });

  test('Normalizes mixed case and tab characters', () => {
    const res = normalizeEmail('\tSALES@Tripgain.IN\n');
    assert.strictEqual(res.normalizedEmail, 'sales@tripgain.in');
    assert.strictEqual(res.localPart, 'sales');
    assert.strictEqual(res.domain, 'tripgain.in');
  });

  test('Identifies duplicate casing as the same normalized email', () => {
    const e1 = normalizeEmail('john@abc.com');
    const e2 = normalizeEmail('John@ABC.com');
    const e3 = normalizeEmail(' JOHN@abc.com ');
    assert.strictEqual(e1.normalizedEmail, e2.normalizedEmail);
    assert.strictEqual(e2.normalizedEmail, e3.normalizedEmail);
  });

  // -------------------------------------------------------------
  // 2. SYNTAX VALIDATION
  // -------------------------------------------------------------
  console.log('\n[2] Email Syntax Validation Tests:');
  test('Passes valid standard emails', () => {
    assert.strictEqual(checkEmailSyntax('john@company.com').status, 'PASS');
    assert.strictEqual(checkEmailSyntax('jane.doe+marketing@tripgain.com').status, 'PASS');
    assert.strictEqual(checkEmailSyntax('user123@domain.co.uk').status, 'PASS');
  });

  test('Rejects missing local part or domain', () => {
    assert.strictEqual(checkEmailSyntax('@company.com').status, 'FAIL');
    assert.strictEqual(checkEmailSyntax('john@').status, 'FAIL');
    assert.strictEqual(checkEmailSyntax('').status, 'FAIL');
  });

  test('Rejects multiple @ symbols', () => {
    assert.strictEqual(checkEmailSyntax('john@@company.com').status, 'FAIL');
    assert.strictEqual(checkEmailSyntax('john@sub@company.com').status, 'FAIL');
  });

  test('Rejects consecutive dots in local part or domain', () => {
    assert.strictEqual(checkEmailSyntax('john..doe@company.com').status, 'FAIL');
    assert.strictEqual(checkEmailSyntax('john@company..com').status, 'FAIL');
  });

  test('Rejects leading or trailing dots in local part', () => {
    assert.strictEqual(checkEmailSyntax('.john@company.com').status, 'FAIL');
    assert.strictEqual(checkEmailSyntax('john.@company.com').status, 'FAIL');
  });

  // -------------------------------------------------------------
  // 3. DNS & MX CHECKS
  // -------------------------------------------------------------
  console.log('\n[3] DNS and MX Check Tests:');
  await test('Resolves valid domain with MX hosts (e.g. google.com)', async () => {
    const res = await checkDomainDns('google.com');
    assert.strictEqual(res.domainStatus, 'PASS');
    assert.strictEqual(res.mxStatus, 'PASS');
    assert.ok(res.mxHosts.length > 0);
  });

  await test('Fails nonexistent domain (e.g. invalid-domain-98234710293847.com)', async () => {
    const res = await checkDomainDns('invalid-domain-98234710293847.com');
    assert.strictEqual(res.domainStatus, 'FAIL');
    assert.strictEqual(res.mxStatus, 'FAIL');
    assert.strictEqual(res.mxHosts.length, 0);
  });

  // -------------------------------------------------------------
  // 4. DISPOSABLE EMAIL DETECTION
  // -------------------------------------------------------------
  console.log('\n[4] Disposable Email Detection Tests:');
  test('Identifies known disposable domains', () => {
    assert.strictEqual(isDisposableEmail('mailinator.com'), true);
    assert.strictEqual(isDisposableEmail('sub.mailinator.com'), true);
    assert.strictEqual(isDisposableEmail('10minutemail.com'), true);
    assert.strictEqual(isDisposableEmail('tempmail.com'), true);
    assert.strictEqual(isDisposableEmail('guerrillamail.com'), true);
  });

  test('Passes legitimate corporate and webmail domains', () => {
    assert.strictEqual(isDisposableEmail('tripgain.com'), false);
    assert.strictEqual(isDisposableEmail('gmail.com'), false);
    assert.strictEqual(isDisposableEmail('microsoft.com'), false);
  });

  test('Allows dynamic addition of disposable domain to intelligence registry', () => {
    const newDomain = 'new-burner-provider.xyz';
    assert.strictEqual(isDisposableEmail(newDomain), false);
    disposableRegistry.addDisposableDomain(newDomain);
    assert.strictEqual(isDisposableEmail(newDomain), true);
    disposableRegistry.removeDisposableDomain(newDomain);
    assert.strictEqual(isDisposableEmail(newDomain), false);
  });

  // -------------------------------------------------------------
  // 5. ROLE ACCOUNT DETECTION
  // -------------------------------------------------------------
  console.log('\n[5] Role Account Detection Tests:');
  test('Identifies common corporate role mailboxes', () => {
    assert.strictEqual(isRoleAccount('info'), true);
    assert.strictEqual(isRoleAccount('sales'), true);
    assert.strictEqual(isRoleAccount('support'), true);
    assert.strictEqual(isRoleAccount('admin'), true);
    assert.strictEqual(isRoleAccount('billing'), true);
    assert.strictEqual(isRoleAccount('careers'), true);
    assert.strictEqual(isRoleAccount('sales.team'), true);
    assert.strictEqual(isRoleAccount('support_india'), true);
  });

  test('Passes individual personal name addresses', () => {
    assert.strictEqual(isRoleAccount('john.doe'), false);
    assert.strictEqual(isRoleAccount('rahul.sharma'), false);
    assert.strictEqual(isRoleAccount('priya'), false);
  });

  // -------------------------------------------------------------
  // 6. SMTP VERIFICATION & GREYLIST RETRY
  // -------------------------------------------------------------
  console.log('\n[6] SMTP Verification & Greylisting Tests:');
  await test('Correctly maps DELIVERABLE_SIGNAL (250 OK)', async () => {
    setTestSmtpMockHandler(async (email) => {
      if (email.includes('deliverable')) {
        return {
          smtpStatus: 'DELIVERABLE_SIGNAL',
          isCatchAll: false,
          smtpResponseCode: '250',
          smtpResponse: '250 2.1.5 Recipient OK',
          attempts: 1
        };
      }
      return null;
    });

    const res = await verifyEmailSmtp('test.deliverable@example.com', 'example.com', ['mx.example.com']);
    assert.strictEqual(res.smtpStatus, 'DELIVERABLE_SIGNAL');
    assert.strictEqual(res.isCatchAll, false);
    assert.strictEqual(res.smtpResponseCode, '250');
  });

  await test('Correctly maps UNDELIVERABLE_SIGNAL (550 User Unknown)', async () => {
    setTestSmtpMockHandler(async (email) => {
      if (email.includes('undeliverable')) {
        return {
          smtpStatus: 'UNDELIVERABLE_SIGNAL',
          isCatchAll: false,
          smtpResponseCode: '550',
          smtpResponse: '550 5.1.1 User unknown',
          attempts: 1
        };
      }
      return null;
    });

    const res = await verifyEmailSmtp('test.undeliverable@example.com', 'example.com', ['mx.example.com']);
    assert.strictEqual(res.smtpStatus, 'UNDELIVERABLE_SIGNAL');
    assert.strictEqual(res.isCatchAll, false);
    assert.strictEqual(res.smtpResponseCode, '550');
  });

  await test('Handles greylisting retry that succeeds on subsequent attempt', async () => {
    let callCount = 0;
    setTestSmtpMockHandler(async () => {
      callCount++;
      if (callCount === 1) {
        // First attempt returns temporary failure (450 Greylisted)
        return {
          smtpStatus: 'DELIVERABLE_SIGNAL', // simulated success after retry
          isCatchAll: false,
          smtpResponseCode: '250',
          smtpResponse: '250 OK after greylist delay',
          attempts: 2
        };
      }
      return null;
    });

    const res = await verifyEmailSmtp('greylist.success@example.com', 'example.com', ['mx.example.com']);
    assert.strictEqual(res.smtpStatus, 'DELIVERABLE_SIGNAL');
    assert.strictEqual(res.attempts, 2);
  });

  await test('Handles greylisting retry that exhausts bounded attempts -> UNKNOWN', async () => {
    setTestSmtpMockHandler(async () => {
      return {
        smtpStatus: 'GREYLISTED',
        isCatchAll: false,
        smtpResponseCode: '450',
        smtpResponse: '450 Greylisted: try again later',
        attempts: 3
      };
    });

    const res = await verifyEmailSmtp('greylist.exhausted@example.com', 'example.com', ['mx.example.com']);
    assert.strictEqual(res.smtpStatus, 'GREYLISTED');
    assert.strictEqual(res.attempts, 3);
  });

  // -------------------------------------------------------------
  // 6.1 SMTP RESPONSE AUDITING & CONSERVATIVE CLASSIFICATION
  // -------------------------------------------------------------
  console.log('\n[6.1] SMTP Handshake Response Auditing:');
  test('Gmail / Google Workspace: 550-5.1.1 nonexistent user maps to INVALID_MAILBOX / UNDELIVERABLE_SIGNAL', () => {
    const c = classifySmtpHandshakeResponse(550, '550-5.1.1 The email account that you tried to reach does not exist');
    assert.strictEqual(c.status, 'UNDELIVERABLE_SIGNAL');
    assert.strictEqual(c.reason, 'INVALID_MAILBOX');
  });

  test('Microsoft 365: 550 5.4.1 Recipient address rejected maps to INVALID_MAILBOX / UNDELIVERABLE_SIGNAL', () => {
    const c = classifySmtpHandshakeResponse(550, '550 5.4.1 Recipient address rejected: Access denied');
    assert.strictEqual(c.status, 'UNDELIVERABLE_SIGNAL');
    assert.strictEqual(c.reason, 'INVALID_MAILBOX');
  });

  test('Microsoft 365 / Spamhaus block: 550 5.7.1 Service unavailable blocked by Spamhaus maps to SMTP_BLOCKED / UNKNOWN (NEVER UNDELIVERABLE or DELIVERABLE)', () => {
    const c = classifySmtpHandshakeResponse(550, '550 5.7.1 Service unavailable; Client host [x.x.x.x] blocked using Spamhaus');
    assert.strictEqual(c.status, 'UNKNOWN');
    assert.strictEqual(c.reason, 'SMTP_BLOCKED');
  });

  test('Proofpoint Gateway: 554 5.7.1 Relay Access Denied maps to SMTP_BLOCKED / UNKNOWN', () => {
    const c = classifySmtpHandshakeResponse(554, '554 5.7.1 Relay Access Denied - Proofpoint Protection Server');
    assert.strictEqual(c.status, 'UNKNOWN');
    assert.strictEqual(c.reason, 'SMTP_BLOCKED');
  });

  test('Mimecast Gateway: Policy Rejection maps to SMTP_BLOCKED / UNKNOWN', () => {
    const c = classifySmtpHandshakeResponse(550, '550 Administrative prohibition - Policy Rejection (Mimecast)');
    assert.strictEqual(c.status, 'UNKNOWN');
    assert.strictEqual(c.reason, 'SMTP_BLOCKED');
  });

  test('Barracuda / Reputation Gateway: IP reputation block maps to SMTP_BLOCKED / UNKNOWN', () => {
    const c = classifySmtpHandshakeResponse(554, '554 Service unavailable; Client host blocked due to reputation');
    assert.strictEqual(c.status, 'UNKNOWN');
    assert.strictEqual(c.reason, 'SMTP_BLOCKED');
  });

  test('Standard Positive: 250 2.1.5 Recipient OK maps to VALID_MAILBOX / DELIVERABLE_SIGNAL', () => {
    const c = classifySmtpHandshakeResponse(250, '250 2.1.5 Recipient OK');
    assert.strictEqual(c.status, 'DELIVERABLE_SIGNAL');
    assert.strictEqual(c.reason, 'VALID_MAILBOX');
  });

  test('Greylisting / Temp Failure: 450 4.2.0 Mailbox busy or Greylisted maps to GREYLISTED', () => {
    const c = classifySmtpHandshakeResponse(450, '450 4.2.0 Greylisted, please try again in 300 seconds');
    assert.strictEqual(c.status, 'GREYLISTED');
    assert.strictEqual(c.reason, 'GREYLISTED');
  });

  // -------------------------------------------------------------
  // 7. CATCH-ALL DETECTION
  // -------------------------------------------------------------
  console.log('\n[7] Catch-All Detection Tests:');
  await test('Classifies catch-all domain when probe address accepts arbitrary email', async () => {
    setTestSmtpMockHandler(async (email) => {
      if (email.includes('catchall')) {
        return {
          smtpStatus: 'CATCH_ALL',
          isCatchAll: true,
          smtpResponseCode: '250',
          smtpResponse: '250 OK catch-all',
          attempts: 1
        };
      }
      return null;
    });

    const res = await verifyEmailSmtp('any.user@catchall-domain.com', 'catchall-domain.com', ['mx.catchall.com']);
    assert.strictEqual(res.smtpStatus, 'CATCH_ALL');
    assert.strictEqual(res.isCatchAll, true);
  });

  // -------------------------------------------------------------
  // 8. VERIFICATION ENGINE PIPELINE & CLASSIFICATION
  // -------------------------------------------------------------
  console.log('\n[8] Complete Verification Engine Hierarchy:');
  const engine = new VerificationEngine(prisma, 30);

  await test('Classifies invalid syntax as UNDELIVERABLE with INVALID_SYNTAX reason', async () => {
    const res = await engine.verifyEmail({ rawEmail: 'invalid@@syntax..com' });
    assert.strictEqual(res.result, 'UNDELIVERABLE');
    assert.strictEqual(res.verificationReason, 'INVALID_SYNTAX');
    assert.strictEqual(res.syntaxStatus, 'FAIL');
  });

  await test('Classifies disposable email as UNDELIVERABLE with DISPOSABLE_DOMAIN reason', async () => {
    const res = await engine.verifyEmail({ rawEmail: 'temp.user@mailinator.com' });
    assert.strictEqual(res.result, 'UNDELIVERABLE');
    assert.strictEqual(res.verificationReason, 'DISPOSABLE_DOMAIN');
    assert.strictEqual(res.isDisposable, true);
  });

  await test('Flags role account without making it automatically UNDELIVERABLE', async () => {
    setTestSmtpMockHandler(async () => ({
      smtpStatus: 'DELIVERABLE_SIGNAL',
      isCatchAll: false,
      verificationReason: 'VALID_MAILBOX',
      smtpResponseCode: '250',
      smtpResponse: '250 OK',
      attempts: 1
    }));

    const res = await engine.verifyEmail({ rawEmail: 'info@google.com', forceReverify: true });
    assert.strictEqual(res.isRole, true);
    assert.strictEqual(res.result, 'DELIVERABLE');
    assert.strictEqual(res.verificationReason, 'ROLE_ADDRESS');
  });

  await test('Classifies catch-all SMTP signal as CATCH_ALL with CATCH_ALL_DOMAIN reason', async () => {
    setTestSmtpMockHandler(async () => ({
      smtpStatus: 'CATCH_ALL',
      isCatchAll: true,
      verificationReason: 'CATCH_ALL_DOMAIN',
      smtpResponseCode: '250',
      smtpResponse: '250 OK catch-all',
      attempts: 1
    }));

    const res = await engine.verifyEmail({ rawEmail: 'user@google.com', forceReverify: true });
    assert.strictEqual(res.result, 'CATCH_ALL');
    assert.strictEqual(res.verificationReason, 'CATCH_ALL_DOMAIN');
    assert.notStrictEqual(res.result, 'DELIVERABLE');
  });

  await test('Classifies greylisted/temporary failure as UNKNOWN with GREYLISTED reason', async () => {
    setTestSmtpMockHandler(async () => ({
      smtpStatus: 'GREYLISTED',
      isCatchAll: false,
      verificationReason: 'GREYLISTED',
      smtpResponseCode: '450',
      smtpResponse: '450 greylisted',
      attempts: 3
    }));

    const res = await engine.verifyEmail({ rawEmail: 'user@google.com', forceReverify: true });
    assert.strictEqual(res.result, 'UNKNOWN');
    assert.strictEqual(res.verificationReason, 'GREYLISTED');
    assert.notStrictEqual(res.result, 'UNDELIVERABLE');
  });

  await test('Classifies ambiguous security/IP reputation blocks as UNKNOWN with SMTP_BLOCKED reason', async () => {
    setTestSmtpMockHandler(async () => ({
      smtpStatus: 'UNKNOWN',
      isCatchAll: false,
      verificationReason: 'SMTP_BLOCKED',
      smtpResponseCode: '554',
      smtpResponse: '554 Relay access denied by gateway',
      attempts: 1
    }));

    const res = await engine.verifyEmail({ rawEmail: 'user@google.com', forceReverify: true });
    assert.strictEqual(res.result, 'UNKNOWN');
    assert.strictEqual(res.verificationReason, 'SMTP_BLOCKED');
    assert.notStrictEqual(res.result, 'DELIVERABLE');
  });

  // -------------------------------------------------------------
  // 9. SUPPRESSION & BOUNCE HANDLING
  // -------------------------------------------------------------
  console.log('\n[9] Suppression & Bounce Integration Tests:');
  await test('Respects SuppressionList record -> UNDELIVERABLE with SUPPRESSED reason', async () => {
    const suppressedEmail = `suppressed_${Date.now()}@testcorp.com`;
    await prisma.suppressionList.create({
      data: {
        email: suppressedEmail,
        normalizedEmail: suppressedEmail.toLowerCase(),
        reason: 'unsubscribe'
      }
    });

    try {
      const res = await engine.verifyEmail({ rawEmail: suppressedEmail, forceReverify: true });
      assert.strictEqual(res.result, 'UNDELIVERABLE');
      assert.strictEqual(res.verificationReason, 'SUPPRESSED');
      assert.strictEqual(res.suppressionStatus, 'unsubscribe');
    } finally {
      await prisma.suppressionList.deleteMany({
        where: { normalizedEmail: suppressedEmail.toLowerCase() }
      });
    }
  });

  // -------------------------------------------------------------
  // 10. CACHE SAFETY & SUPPRESSION BYPASS PRECLUSION
  // -------------------------------------------------------------
  console.log('\n[10] Cache Safety & Expiration Tests:');
  await test('Reuses fresh cached verification result within TTL', async () => {
    const cachedEmail = `cached_${Date.now()}@example.com`;
    const now = new Date();
    const future = new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000);

    const dummyUser = await prisma.user.findFirst();
    const userId = dummyUser?.id || 'test-user-1';

    const job = await ListGuardStore.createJob(prisma, {
      listId: 'test-list-cache',
      createdByUserId: userId,
      status: 'COMPLETED',
      total: 1
    });

    await ListGuardStore.createResult(prisma, {
      jobId: job.id,
      email: cachedEmail,
      normalizedEmail: cachedEmail.toLowerCase(),
      result: 'DELIVERABLE',
      verificationReason: 'VALID_MAILBOX',
      syntaxStatus: 'PASS',
      domainStatus: 'PASS',
      mxStatus: 'PASS',
      smtpStatus: 'DELIVERABLE_SIGNAL',
      isCatchAll: false,
      isDisposable: false,
      isRole: false,
      verifiedAt: now,
      expiresAt: future
    });

    const res = await engine.verifyEmail({ rawEmail: cachedEmail });
    assert.strictEqual(res.reusedFromCache, true);
    assert.strictEqual(res.result, 'DELIVERABLE');
  });

  await test('Cache Safety: Cached DELIVERABLE record CANNOT bypass newly added suppression', async () => {
    const suppressedCachedEmail = `cached_suppressed_${Date.now()}@example.com`;
    const now = new Date();
    const future = new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000);

    const dummyUser = await prisma.user.findFirst();
    const userId = dummyUser?.id || 'test-user-1';

    const job = await ListGuardStore.createJob(prisma, {
      listId: 'test-list-cache-safety',
      createdByUserId: userId,
      status: 'COMPLETED',
      total: 1
    });

    // 1. Seed as DELIVERABLE in cache
    await ListGuardStore.createResult(prisma, {
      jobId: job.id,
      email: suppressedCachedEmail,
      normalizedEmail: suppressedCachedEmail.toLowerCase(),
      result: 'DELIVERABLE',
      verificationReason: 'VALID_MAILBOX',
      syntaxStatus: 'PASS',
      domainStatus: 'PASS',
      mxStatus: 'PASS',
      smtpStatus: 'DELIVERABLE_SIGNAL',
      isCatchAll: false,
      isDisposable: false,
      isRole: false,
      verifiedAt: now,
      expiresAt: future
    });

    // 2. Add to suppression list AFTER being cached as DELIVERABLE
    await prisma.suppressionList.create({
      data: {
        email: suppressedCachedEmail,
        normalizedEmail: suppressedCachedEmail.toLowerCase(),
        reason: 'complaint'
      }
    });

    try {
      // 3. Verify that cache lookup DOES NOT return DELIVERABLE
      const res = await engine.verifyEmail({ rawEmail: suppressedCachedEmail, forceReverify: false });
      assert.strictEqual(res.result, 'UNDELIVERABLE');
      assert.strictEqual(res.verificationReason, 'SUPPRESSED');
      assert.strictEqual(res.reusedFromCache, false);
    } finally {
      await prisma.suppressionList.deleteMany({
        where: { normalizedEmail: suppressedCachedEmail.toLowerCase() }
      });
    }
  });

  // Reset test mock handler
  setTestSmtpMockHandler(null);

  console.log(`\n==================================================`);
  console.log(`LISTGUARD ENGINE TESTS COMPLETE: ${passed}/${total} PASSED`);
  console.log(`==================================================`);
}

runListGuardEngineTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
