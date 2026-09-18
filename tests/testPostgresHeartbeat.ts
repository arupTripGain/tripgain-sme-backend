import assert from 'assert';
import { PrismaClient } from '@prisma/client';
import { WorkerHealthService } from '../src/services/listGuard/workerHealth';

const prisma = new PrismaClient();

async function main() {
  console.log('--- TESTING POSTGRESQL WORKER HEARTBEAT LIFECYCLE ---');

  // Clean previous test records
  await prisma.$executeRawUnsafe(`DELETE FROM "ListGuardWorker" WHERE "workerId" = 'test-worker-pg-1';`);

  // 1. Register fresh heartbeat
  const now = new Date();
  await WorkerHealthService.registerHeartbeat(prisma, {
    workerId: 'test-worker-pg-1',
    version: '1.0.0',
    status: 'ONLINE',
    hostname: 'test-host-pg',
    startedAt: now,
    lastHeartbeatAt: now,
    activeJobs: 0,
    processedCount: 0,
    currentJobId: null
  });

  // 2. Query status: should be ONLINE
  const health1 = await WorkerHealthService.getWorkerHealthStatus(prisma, 45000);
  console.log('1. Active worker status:', health1.status, '(Available:', health1.available, ')');
  assert.strictEqual(health1.available, true);
  assert.strictEqual(health1.status, 'ONLINE');
  const foundWorker = health1.workers.find(w => w.workerId === 'test-worker-pg-1');
  assert.ok(foundWorker, 'test-worker-pg-1 must be in active workers');
  assert.strictEqual(foundWorker.hostname, 'test-host-pg');

  // 3. Make heartbeat stale (> 45s ago, e.g. 60 seconds ago)
  await prisma.$executeRawUnsafe(`
    UPDATE "ListGuardWorker"
    SET "lastHeartbeatAt" = NOW() - INTERVAL '60 seconds'
    WHERE "workerId" = 'test-worker-pg-1';
  `);

  // 4. Query status: should now be UNAVAILABLE (unless other active workers exist)
  const health2 = await WorkerHealthService.getWorkerHealthStatus(prisma, 45000);
  console.log('2. Stale worker status (>45s):', health2.status, '(Available:', health2.available, ')');
  const foundStale = health2.workers.find(w => w.workerId === 'test-worker-pg-1');
  assert.strictEqual(foundStale, undefined, 'Stale worker must NOT be reported as active');

  // 5. Restart / resume worker: fresh heartbeat
  await WorkerHealthService.registerHeartbeat(prisma, {
    workerId: 'test-worker-pg-1',
    version: '1.0.0',
    status: 'ONLINE',
    hostname: 'test-host-pg',
    startedAt: now,
    lastHeartbeatAt: new Date(),
    activeJobs: 0,
    processedCount: 5,
    currentJobId: null
  });

  const health3 = await WorkerHealthService.getWorkerHealthStatus(prisma, 45000);
  console.log('3. Resumed worker status:', health3.status, '(Available:', health3.available, ')');
  assert.strictEqual(health3.available, true);
  assert.strictEqual(health3.status, 'ONLINE');

  // 6. Graceful shutdown / mark OFFLINE
  await WorkerHealthService.markWorkerOffline(prisma, 'test-worker-pg-1');
  const health4 = await WorkerHealthService.getWorkerHealthStatus(prisma, 45000);
  console.log('4. Offline worker status:', health4.status, '(Available:', health4.available, ')');
  const foundOffline = health4.workers.find(w => w.workerId === 'test-worker-pg-1');
  assert.strictEqual(foundOffline, undefined, 'Offline worker must NOT be reported as active');

  // Clean up
  await prisma.$executeRawUnsafe(`DELETE FROM "ListGuardWorker" WHERE "workerId" = 'test-worker-pg-1';`);
  console.log('✓ ALL POSTGRESQL HEARTBEAT TESTS PASSED SUCCESSFULLY!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
