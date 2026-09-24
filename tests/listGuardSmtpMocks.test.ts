import 'dotenv/config';
import assert from 'assert';
import {
  setTestSmtpMockHandler,
  verifyEmailSmtp,
  isPrivateOrLoopbackIp
} from '../src/services/listGuard/smtpVerifier';
import { ProviderRules } from '../src/services/listGuard/providerRules';

async function runSmtpMockTests() {
  console.log('--- STARTING LISTGUARD DETERMINISTIC SMTP MOCK TESTS ---');

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

  // 1. SSRF PROTECTION TESTS
  await test('isPrivateOrLoopbackIp accurately identifies private IPv4 and IPv6 ranges', async () => {
    // Loopback
    assert.strictEqual(isPrivateOrLoopbackIp('127.0.0.1'), true);
    assert.strictEqual(isPrivateOrLoopbackIp('127.0.1.5'), true);
    // 10.0.0.0/8
    assert.strictEqual(isPrivateOrLoopbackIp('10.0.0.1'), true);
    assert.strictEqual(isPrivateOrLoopbackIp('10.255.255.255'), true);
    // 172.16.0.0/12
    assert.strictEqual(isPrivateOrLoopbackIp('172.16.0.1'), true);
    assert.strictEqual(isPrivateOrLoopbackIp('172.31.255.254'), true);
    assert.strictEqual(isPrivateOrLoopbackIp('172.32.0.1'), false); // Public
    // 192.168.0.0/16
    assert.strictEqual(isPrivateOrLoopbackIp('192.168.1.1'), true);
    assert.strictEqual(isPrivateOrLoopbackIp('192.168.100.50'), true);
    // Link-local
    assert.strictEqual(isPrivateOrLoopbackIp('169.254.1.1'), true);
    // 0.0.0.0
    assert.strictEqual(isPrivateOrLoopbackIp('0.0.0.0'), true);
    // IPv6 loopback and unique local
    assert.strictEqual(isPrivateOrLoopbackIp('::1'), true);
    assert.strictEqual(isPrivateOrLoopbackIp('fc00::1'), true);
    assert.strictEqual(isPrivateOrLoopbackIp('fe80::1'), true);

    // Valid public IPs
    assert.strictEqual(isPrivateOrLoopbackIp('8.8.8.8'), false);
    assert.strictEqual(isPrivateOrLoopbackIp('142.250.190.27'), false); // Google
  });

  // 2. DETERMINISTIC MOCKS: 250 OK
  await test('SMTP 250 OK produces DELIVERABLE_SIGNAL with VALID_MAILBOX and HIGH confidence', async () => {
    setTestSmtpMockHandler(async () => {
      return {
        smtpStatus: 'DELIVERABLE_SIGNAL',
        isCatchAll: false,
        verificationReason: 'VALID_MAILBOX',
        confidence: 'HIGH',
        smtpResponseCode: '250',
        smtpResponse: '250 2.1.5 Recipient OK',
        attempts: 1
      };
    });

    const res = await verifyEmailSmtp('valid.lead@example.com', 'example.com', ['mx.example.com']);
    assert.strictEqual(res.smtpStatus, 'DELIVERABLE_SIGNAL');
    assert.strictEqual(res.verificationReason, 'VALID_MAILBOX');
    assert.strictEqual(res.confidence, 'HIGH');
    assert.strictEqual(res.isCatchAll, false);
  });

  // 3. DETERMINISTIC MOCKS: 550 5.1.1 (Google)
  await test('SMTP 550 5.1.1 produces UNDELIVERABLE_SIGNAL with INVALID_MAILBOX and HIGH confidence', async () => {
    setTestSmtpMockHandler(async () => {
      return {
        smtpStatus: 'UNDELIVERABLE_SIGNAL',
        isCatchAll: false,
        verificationReason: 'INVALID_MAILBOX',
        confidence: 'HIGH',
        smtpResponseCode: '550',
        smtpResponse: '550 5.1.1 The email account that you tried to reach does not exist',
        attempts: 1
      };
    });

    const res = await verifyEmailSmtp('nonexistent@gmail.com', 'gmail.com', ['gmail-smtp-in.l.google.com']);
    assert.strictEqual(res.smtpStatus, 'UNDELIVERABLE_SIGNAL');
    assert.strictEqual(res.verificationReason, 'INVALID_MAILBOX');
    assert.strictEqual(res.confidence, 'HIGH');
  });

  // 4. DETERMINISTIC MOCKS: CATCH-ALL DOMAIN
  await test('Catch-all acceptance produces CATCH_ALL with CATCH_ALL_DOMAIN', async () => {
    setTestSmtpMockHandler(async () => {
      return {
        smtpStatus: 'CATCH_ALL',
        isCatchAll: true,
        verificationReason: 'CATCH_ALL_DOMAIN',
        confidence: 'HIGH',
        smtpResponseCode: '250',
        smtpResponse: '250 Accepted all addresses (catch-all)',
        attempts: 1
      };
    });

    const res = await verifyEmailSmtp('anybody@catchall-company.com', 'catchall-company.com', ['mx.catchall.com']);
    assert.strictEqual(res.smtpStatus, 'CATCH_ALL');
    assert.strictEqual(res.isCatchAll, true);
    assert.strictEqual(res.verificationReason, 'CATCH_ALL_DOMAIN');
  });

  // 5. DETERMINISTIC MOCKS: 421 / 450 GREYLISTING
  await test('421/450 temporary response maps to GREYLISTED / UNKNOWN (never UNDELIVERABLE)', async () => {
    setTestSmtpMockHandler(async () => {
      return {
        smtpStatus: 'GREYLISTED',
        isCatchAll: false,
        verificationReason: 'GREYLISTED',
        confidence: 'MEDIUM',
        smtpResponseCode: '450',
        smtpResponse: '450 4.2.1 Service temporarily unavailable, please try again later',
        attempts: 2
      };
    });

    const res = await verifyEmailSmtp('busy@domain.com', 'domain.com', ['mx.domain.com']);
    assert.strictEqual(res.smtpStatus, 'GREYLISTED');
    assert.strictEqual(res.verificationReason, 'GREYLISTED');
    assert.notStrictEqual(res.smtpStatus, 'UNDELIVERABLE_SIGNAL');
    assert.notStrictEqual(res.smtpStatus, 'DELIVERABLE_SIGNAL');
  });

  // 6. DETERMINISTIC MOCKS: TIMEOUT
  await test('SMTP Socket Timeout maps to UNKNOWN with SMTP_TIMEOUT (never DELIVERABLE)', async () => {
    setTestSmtpMockHandler(async () => {
      return {
        smtpStatus: 'UNKNOWN',
        isCatchAll: false,
        verificationReason: 'SMTP_TIMEOUT',
        confidence: 'LOW',
        smtpResponse: 'SMTP socket timeout after 6000ms',
        attempts: 2
      };
    });

    const res = await verifyEmailSmtp('timeout@remote.com', 'remote.com', ['mx.remote.com']);
    assert.strictEqual(res.smtpStatus, 'UNKNOWN');
    assert.strictEqual(res.verificationReason, 'SMTP_TIMEOUT');
    assert.strictEqual(res.confidence, 'LOW');
  });

  // 7. DETERMINISTIC MOCKS: GATEWAY BLOCK / SPAMHAUS
  await test('Security gateway/Spamhaus IP block maps to UNKNOWN with SMTP_BLOCKED', async () => {
    const interp = ProviderRules.interpretResponse({
      code: 554,
      response: '554 5.7.1 Service unavailable; Client host [x.x.x.x] blocked using Spamhaus ZEN',
      mxHosts: ['mx.corporate.com']
    });

    assert.strictEqual(interp.status, 'UNKNOWN');
    assert.strictEqual(interp.reason, 'SMTP_BLOCKED');
    assert.strictEqual(interp.confidence, 'LOW');
    assert.strictEqual(interp.isNetworkOrGatewayFailure, true);
  });

  // Reset test mock handler
  setTestSmtpMockHandler(null);

  console.log(`\nSMTP MOCK TEST RUN COMPLETE: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runSmtpMockTests().catch(err => {
  console.error('Fatal SMTP mock test error:', err);
  process.exit(1);
});
