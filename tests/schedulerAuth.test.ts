import assert from 'assert';
import jwt from 'jsonwebtoken';
import { verifySchedulerAuth } from '../src/controllers/schedulerController';

console.log('====================================================');
console.log('RUNNING SCHEDULER AUTHENTICATION UNIT TESTS');
console.log('Synthetic / Mock Keys Only — Zero Production Secrets');
console.log('====================================================\n');

const MOCK_CRON_SECRET = 'mock_synthetic_cron_secret_for_tests_123';
const MOCK_JWT_SECRET = 'mock_synthetic_jwt_secret_for_tests_456';

// 1. Missing CRON_SECRET configuration on server
{
  const result = verifySchedulerAuth('Bearer mock_synthetic_cron_secret_for_tests_123', undefined, null, '', MOCK_JWT_SECRET);
  assert.strictEqual(result.isAuthorized, false, 'Should fail when CRON_SECRET is unconfigured');
  assert.strictEqual(result.status, 500, 'Should return status 500 when CRON_SECRET is unconfigured');
  console.log('✔ Test 1 passed: Rejects when server CRON_SECRET is not configured (HTTP 500)');
}

// 2. Unauthenticated request (no headers, no user)
{
  const result = verifySchedulerAuth(undefined, undefined, null, MOCK_CRON_SECRET, MOCK_JWT_SECRET);
  assert.strictEqual(result.isAuthorized, false, 'Should reject unauthenticated requests');
  assert.strictEqual(result.status, 401, 'Should return status 401 for unauthenticated requests');
  console.log('✔ Test 2 passed: Rejects requests with missing authentication headers (HTTP 401)');
}

// 3. Invalid CRON_SECRET
{
  const result = verifySchedulerAuth('Bearer wrong_invalid_secret', undefined, null, MOCK_CRON_SECRET, MOCK_JWT_SECRET);
  assert.strictEqual(result.isAuthorized, false, 'Should reject mismatched cron secret');
  assert.strictEqual(result.status, 401, 'Should return status 401 for mismatched secret');
  console.log('✔ Test 3 passed: Rejects requests with invalid Bearer token (HTTP 401)');
}

// 4. Valid CRON_SECRET in Authorization header ("Bearer ...")
{
  const result = verifySchedulerAuth(`Bearer ${MOCK_CRON_SECRET}`, undefined, null, MOCK_CRON_SECRET, MOCK_JWT_SECRET);
  assert.strictEqual(result.isAuthorized, true, 'Should authorize valid Bearer token');
  console.log('✔ Test 4 passed: Authorizes valid "Authorization: Bearer <CRON_SECRET>"');
}

// 5. Valid CRON_SECRET case-insensitive ("bearer ...")
{
  const result = verifySchedulerAuth(`bearer ${MOCK_CRON_SECRET}`, undefined, null, MOCK_CRON_SECRET, MOCK_JWT_SECRET);
  assert.strictEqual(result.isAuthorized, true, 'Should authorize lowercase bearer prefix');
  console.log('✔ Test 5 passed: Authorizes lowercase "bearer <CRON_SECRET>"');
}

// 6. Valid CRON_SECRET in custom header ("x-cron-secret")
{
  const result = verifySchedulerAuth(undefined, MOCK_CRON_SECRET, null, MOCK_CRON_SECRET, MOCK_JWT_SECRET);
  assert.strictEqual(result.isAuthorized, true, 'Should authorize valid x-cron-secret header');
  console.log('✔ Test 6 passed: Authorizes valid "x-cron-secret: <CRON_SECRET>" header');
}

// 7. Authenticated dashboard user via valid JWT Bearer token
{
  const testUserToken = jwt.sign({ userId: 'user-test-123', email: 'admin@test.local', role: 'ADMIN' }, MOCK_JWT_SECRET);
  const result = verifySchedulerAuth(`Bearer ${testUserToken}`, undefined, null, MOCK_CRON_SECRET, MOCK_JWT_SECRET);
  assert.strictEqual(result.isAuthorized, true, 'Should authorize logged-in dashboard user with valid JWT');
  console.log('✔ Test 7 passed: Authorizes authenticated user JWT for dashboard manual force tick');
}

// 8. Pre-populated req.user session
{
  const mockUser = { userId: 'user-456', email: 'user@test.local', role: 'USER' };
  const result = verifySchedulerAuth(undefined, undefined, mockUser, MOCK_CRON_SECRET, MOCK_JWT_SECRET);
  assert.strictEqual(result.isAuthorized, true, 'Should authorize request when req.user is populated');
  console.log('✔ Test 8 passed: Authorizes request with active session user');
}

console.log('\nAll Scheduler Authentication Tests Passed Successfully!\n');
