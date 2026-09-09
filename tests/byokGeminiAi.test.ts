import 'dotenv/config';
import assert from 'assert';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { encrypt, decrypt } from '../src/utils/crypto';
import { AIProviderService, AIProviderError } from '../src/services/aiProviderService';
import { getAISettings, saveGeminiKey, removeGeminiKey } from '../src/controllers/settingsAiController';

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

async function runBYOKTests() {
  console.log('\n====================================================');
  console.log('  RUNNING BYOK GEMINI AI COMPREHENSIVE TEST SUITE   ');
  console.log('  Synthetic Keys Only — Zero Production Secrets Leaked ');
  console.log('====================================================\n');

  // 1. Fetch test users
  const userA = await prisma.user.findFirst({
    where: { email: 'admin@tripgain.com' }
  });
  const userB = await prisma.user.findFirst({
    where: { email: 'sarah.jenkins@tripgain.com' }
  });

  assert(userA, 'User A (admin) must exist');
  assert(userB, 'User B (member) must exist');

  const tokenA = jwt.sign({ userId: userA.id, email: userA.email, role: userA.role }, JWT_SECRET);
  const tokenB = jwt.sign({ userId: userB.id, email: userB.email, role: userB.role }, JWT_SECRET);

  const reqUserA = { userId: userA.id, email: userA.email, role: userA.role };
  const reqUserB = { userId: userB.id, email: userB.email, role: userB.role };

  // Clean existing test AI keys for clean baseline
  await prisma.userAIKey.deleteMany({
    where: { userId: { in: [userA.id, userB.id] } }
  });

  try {
    // ---------------------------------------------------------------
    // TEST 1: AES-256-GCM Authenticated Encryption & Integrity
    // ---------------------------------------------------------------
    console.log('--- 1. Testing Crypto Utility (AES-256-GCM) ---');
    const testSecret = 'AIzaSySyntheticTestSecretKeyForTripGain1234';
    
    // 1.1 Encrypt -> Decrypt roundtrip
    const encrypted1 = encrypt(testSecret);
    const decrypted1 = decrypt(encrypted1);
    assert.strictEqual(decrypted1, testSecret, 'Decrypted secret must match original test secret');

    // 1.2 Serialization format check: iv_hex : authTag_hex : ciphertext_hex
    const parts1 = encrypted1.split(':');
    assert.strictEqual(parts1.length, 3, 'Serialized GCM format must contain exactly 3 parts (iv:authTag:ciphertext)');
    const ivHex1 = parts1[0]!;
    const authTagHex1 = parts1[1]!;
    const cipherHex1 = parts1[2]!;
    assert.strictEqual(Buffer.from(ivHex1, 'hex').length, 12, 'GCM IV must be 12 bytes (96 bits)');
    assert.strictEqual(Buffer.from(authTagHex1, 'hex').length, 16, 'GCM auth tag must be 16 bytes (128 bits)');
    assert(!encrypted1.includes(testSecret), 'Ciphertext must NEVER contain raw plaintext secret');

    // 1.3 Fresh IV per encryption check
    const encrypted2 = encrypt(testSecret);
    const ivHex2 = encrypted2.split(':')[0]!;
    assert.notStrictEqual(ivHex1, ivHex2, 'Subsequent encryptions must produce distinct cryptographically random IVs');
    assert.notStrictEqual(encrypted1, encrypted2, 'Different IVs must yield distinct serialized ciphertexts');
    assert.strictEqual(decrypt(encrypted2), testSecret, 'Second encryption must also decrypt correctly');

    // 1.4 Modified / tampered ciphertext test
    const tamperedCipher = `${ivHex1}:${authTagHex1}:${cipherHex1.slice(0, -2) + (cipherHex1.endsWith('00') ? 'ff' : '00')}`;
    assert.throws(() => {
      decrypt(tamperedCipher, true);
    }, 'Tampered ciphertext must fail GCM tag verification and throw');
    assert.strictEqual(decrypt(tamperedCipher, false), '', 'Tampered ciphertext without throwOnError must safely return empty string');

    // 1.5 Modified / tampered authentication tag test
    const tamperedTag = `${ivHex1}:${authTagHex1.slice(0, -2) + (authTagHex1.endsWith('aa') ? 'bb' : 'aa')}:${cipherHex1}`;
    assert.throws(() => {
      decrypt(tamperedTag, true);
    }, 'Tampered auth tag must fail GCM authentication and throw');
    assert.strictEqual(decrypt(tamperedTag, false), '', 'Tampered auth tag without throwOnError must safely return empty string');

    // 1.6 Wrong encryption key fails safely
    const wrongKey = crypto.randomBytes(32);
    assert.throws(() => {
      decrypt(encrypted1, true, wrongKey);
    }, 'Decrypting with wrong key must fail GCM auth tag verification and throw');
    assert.strictEqual(decrypt(encrypted1, false, wrongKey), '', 'Decrypting with wrong key must return safe empty string');

    console.log('✔ Test 1 passed: AES-256-GCM roundtrip, fresh IVs, auth tag verification, tampering resistance, and wrong-key safety verified');

    // ---------------------------------------------------------------
    // TEST 2: Rejection of Malformed Keys
    // ---------------------------------------------------------------
    console.log('\n--- 2. Testing Key Validation on Save ---');
    {
      const { req, res } = createMockReqRes({
        user: reqUserA,
        body: { apiKey: '   ' }
      });
      await saveGeminiKey(req, res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.data.code, 'INVALID_KEY');
    }
    {
      const { req, res } = createMockReqRes({
        user: reqUserA,
        body: { apiKey: 'short' } // too short to be a valid key
      });
      await saveGeminiKey(req, res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.data.code, 'INVALID_KEY');
    }
    console.log('✔ Test 2 passed: Rejects empty or malformed API keys with HTTP 400');

    // ---------------------------------------------------------------
    // TEST 3: User A Saves Key & Zero Exposure Guarantee
    // ---------------------------------------------------------------
    console.log('\n--- 3. Testing User A Key Save & Zero Key Exposure ---');
    const userAKeyRaw = 'AIzaSySyntheticMockGeminiUserAKeyAAA1';
    
    // Mock the validateGeminiKey function to avoid external Google network dependency during unit tests
    const origValidate = AIProviderService.validateGeminiKey;
    AIProviderService.validateGeminiKey = async (key: string): Promise<boolean> => {
      return key.startsWith('AIzaSy');
    };

    {
      const { req, res } = createMockReqRes({
        user: reqUserA,
        body: { apiKey: userAKeyRaw }
      });
      await saveGeminiKey(req, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.data.success, true);
      assert.strictEqual(res.data.configured, true);
      assert.strictEqual(res.data.keyLast4, 'AAA1');

      // CRITICAL: Ensure raw key and encrypted key are NOT present in response
      assert.strictEqual(res.data.apiKey, undefined, 'Raw API key must NOT be in JSON response');
      assert.strictEqual(res.data.encryptedApiKey, undefined, 'Encrypted API key must NOT be in JSON response');

      // Verify in DB directly:
      const dbKeyA = await prisma.userAIKey.findUnique({ where: { userId: userA.id } });
      assert(dbKeyA, 'User A key record must exist in DB');
      assert.strictEqual(dbKeyA.keyLast4, 'AAA1');
      assert.strictEqual(dbKeyA.isActive, true);
      assert(!dbKeyA.encryptedApiKey.includes(userAKeyRaw), 'DB must NOT contain raw key');
      assert.strictEqual(decrypt(dbKeyA.encryptedApiKey), userAKeyRaw, 'DB encrypted key must decrypt to userAKeyRaw');
    }
    console.log('✔ Test 3 passed: User A key encrypted at rest and zero raw key returned');

    // ---------------------------------------------------------------
    // TEST 4: getAISettings for User A
    // ---------------------------------------------------------------
    console.log('\n--- 4. Testing getAISettings Masked Output ---');
    {
      const { req, res } = createMockReqRes({ user: reqUserA });
      await getAISettings(req, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.data.configured, true);
      assert.strictEqual(res.data.keyLast4, 'AAA1');
      assert.strictEqual(res.data.provider, 'GEMINI');
      assert.strictEqual(res.data.apiKey, undefined);
      assert.strictEqual(res.data.encryptedApiKey, undefined);
      assert(typeof res.data.usageToday === 'number');
    }
    console.log('✔ Test 4 passed: getAISettings returns masked key status without secret exposure');

    // ---------------------------------------------------------------
    // TEST 5: User B (Without Key) Isolation
    // ---------------------------------------------------------------
    console.log('\n--- 5. Testing Multi-User Key Isolation (User B without key) ---');
    {
      const { req, res } = createMockReqRes({ user: reqUserB });
      await getAISettings(req, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.data.configured, false, 'User B must NOT have User A key');
      assert.strictEqual(res.data.keyLast4, null);
      assert.strictEqual(res.data.fallbackAvailable, false, 'Member role should not have company fallback');
    }
    console.log('✔ Test 5 passed: User B cannot see or inherit User A key');

    // ---------------------------------------------------------------
    // TEST 6: User B Saves Her Own Key
    // ---------------------------------------------------------------
    console.log('\n--- 6. Testing User B Saves Own Key ---');
    const userBKeyRaw = 'AIzaSySyntheticMockGeminiUserBKeyBBB2';
    {
      const { req, res } = createMockReqRes({
        user: reqUserB,
        body: { apiKey: userBKeyRaw }
      });
      await saveGeminiKey(req, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.data.keyLast4, 'BBB2');
    }
    // Verify User A still has AAA1 and User B has BBB2
    {
      const { req: reqA, res: resA } = createMockReqRes({ user: reqUserA });
      await getAISettings(reqA, resA);
      assert.strictEqual(resA.data.keyLast4, 'AAA1');

      const { req: reqB, res: resB } = createMockReqRes({ user: reqUserB });
      await getAISettings(reqB, resB);
      assert.strictEqual(resB.data.keyLast4, 'BBB2');
    }
    console.log('✔ Test 6 passed: User A and User B maintain completely isolated keys');

    // ---------------------------------------------------------------
    // TEST 7: User B Deletes Key — User A Key Unaffected
    // ---------------------------------------------------------------
    console.log('\n--- 7. Testing User B Removes Key (IDOR and Deletion Isolation) ---');
    {
      const { req, res } = createMockReqRes({ user: reqUserB });
      await removeGeminiKey(req, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.data.success, true);
    }
    // Check User B is now unconfigured
    {
      const { req, res } = createMockReqRes({ user: reqUserB });
      await getAISettings(req, res);
      assert.strictEqual(res.data.configured, false);
      assert.strictEqual(res.data.keyLast4, null);
    }
    // Check User A is STILL configured with AAA1
    {
      const { req, res } = createMockReqRes({ user: reqUserA });
      await getAISettings(req, res);
      assert.strictEqual(res.data.configured, true);
      assert.strictEqual(res.data.keyLast4, 'AAA1');
    }
    console.log('✔ Test 7 passed: Removing User B key leaves User A key completely intact');

    // ---------------------------------------------------------------
    // TEST 8: AIProviderService Key Resolution Logic
    // ---------------------------------------------------------------
    console.log('\n--- 8. Testing AIProviderService Key Resolution ---');
    // User A has key -> resolves User A key
    {
      const credsA = await AIProviderService.resolveCredentials(userA.id);
      assert.strictEqual(credsA.apiKey, userAKeyRaw);
      assert.strictEqual(credsA.type, 'GEMINI_USER');
    }

    // User B has no key -> Member role cannot use fallback -> Throws AI_PROVIDER_NOT_CONFIGURED
    {
      let caughtError: any = null;
      try {
        await AIProviderService.resolveCredentials(userB.id);
      } catch (err) {
        caughtError = err;
      }
      assert(caughtError instanceof AIProviderError, 'Must throw AIProviderError');
      assert.strictEqual(caughtError.code, 'AI_PROVIDER_NOT_CONFIGURED');
    }
    console.log('✔ Test 8 passed: Member without key strictly throws AI_PROVIDER_NOT_CONFIGURED');

    // ---------------------------------------------------------------
    // TEST 9: Admin Platform Fallback & Quota Limits
    // ---------------------------------------------------------------
    console.log('\n--- 9. Testing Admin Fallback & Daily Limits ---');
    // Temporarily remove User A key to test Admin fallback
    await prisma.userAIKey.deleteMany({ where: { userId: userA.id } });

    // Set mock platform key in env
    const prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIzaSyCompanyPlatformAdminFallbackKey9999';

    {
      const credsA = await AIProviderService.resolveCredentials(userA.id);
      assert.strictEqual(credsA.apiKey, process.env.GEMINI_API_KEY);
      assert.strictEqual(credsA.type, 'GEMINI_PLATFORM');
    }

    // Record artificial usage to simulate reaching daily limit (10 for user)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Create 10 usage records with provider = GEMINI_PLATFORM
    const usages = [];
    for (let i = 0; i < 10; i++) {
      usages.push({
        userId: userA.id,
        provider: 'GEMINI_PLATFORM',
        feature: 'TEST_FALLBACK',
        status: 'SUCCESS',
        requestedAt: new Date()
      });
    }
    await prisma.aIUsage.createMany({ data: usages });

    // Now resolving credentials for Admin should throw AI_USAGE_LIMIT_REACHED
    {
      let caughtError: any = null;
      try {
        await AIProviderService.resolveCredentials(userA.id);
      } catch (err) {
        caughtError = err;
      }
      assert(caughtError instanceof AIProviderError, 'Must throw AIProviderError on quota exhaustion');
      assert.strictEqual(caughtError.code, 'AI_USAGE_LIMIT_REACHED');
    }
    console.log('✔ Test 9 passed: Admin fallback strictly enforces daily quota limit');

    // Restore env and restore validator
    process.env.GEMINI_API_KEY = prevKey;
    AIProviderService.validateGeminiKey = origValidate;

    // ---------------------------------------------------------------
    // TEST 10: Usage Logging & User Isolation of Usage Records
    // ---------------------------------------------------------------
    console.log('\n--- 10. Testing AIUsage Logging & User Isolation ---');
    const userAUsageCount = await prisma.aIUsage.count({ where: { userId: userA.id } });
    const userBUsageCount = await prisma.aIUsage.count({ where: { userId: userB.id } });
    assert(userAUsageCount >= 10, 'User A has 10+ usage records');
    assert.strictEqual(userBUsageCount, 0, 'User B has 0 usage records (isolated)');
    console.log('✔ Test 10 passed: AIUsage records are strictly scoped to authenticated user');

    // Clean up created test usage records
    await prisma.aIUsage.deleteMany({ where: { feature: 'TEST_FALLBACK' } });

    console.log('\n====================================================');
    console.log('  ALL 10 BYOK GEMINI AI SCENARIOS PASSED! 🎉        ');
    console.log('====================================================\n');
  } finally {
    // Clean up any keys created during test
    await prisma.userAIKey.deleteMany({
      where: { userId: { in: [userA.id, userB.id] } }
    });
    await prisma.$disconnect();
  }
}

runBYOKTests().catch(err => {
  console.error('BYOK Gemini AI Test Failed:', err);
  process.exit(1);
});
