import { Client } from 'pg';
import { hashStringTo32BitInt } from './quotaService';

// Deterministic 32-bit signed integer key for PostgreSQL advisory locking
export const IMAP_SYNC_LOCK_KEY = hashStringTo32BitInt('cron_global_imap_sync_lock');

export interface LockExecutionResult<T> {
  acquired: boolean;
  result?: T;
  error?: any;
}

/**
 * Executes an operation under a dedicated PostgreSQL session-level advisory lock (pg_try_advisory_lock).
 * 
 * Concurrency & Architecture Guarantees:
 * 1. Dedicated Session: Connects using a dedicated pg.Client connection, avoiding connection pool starvation
 *    and never holding a Prisma interactive transaction open during lengthy network I/O.
 * 2. Non-blocking Atomic Acquisition: Executes SELECT pg_try_advisory_lock(key).
 *    If another worker/instance is holding the lock, immediately returns { acquired: false }.
 * 3. Connection Held: Keeps the dedicated connection active for the entire duration of `fn()`.
 * 4. Deterministic Cleanup: In the finally block, calls pg_advisory_unlock(key) and ends the client.
 * 5. Crash Immunity: If the process terminates or crashes unexpectedly, PostgreSQL automatically
 *    and immediately releases the session lock when the TCP socket closes.
 * 6. Zero Schema Footprint: Uses PostgreSQL's native advisory lock system. ZERO table creations,
 *    ZERO schema mutations, and ZERO migrations.
 * 
 * @param fn The async function to execute while holding the lock (e.g. syncAllActiveMailboxes)
 * @param _timeoutMs Optional timeout parameter for backward compatibility
 */
export async function executeWithImapSyncLock<T>(
  fn: () => Promise<T>,
  _timeoutMs?: number
): Promise<LockExecutionResult<T>> {
  const rawUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new Error('[CronLockService] DATABASE_URL is not configured.');
  }

  // Session-level advisory locks require a direct connection (bypassing PgBouncer transaction pooling)
  const databaseUrl = rawUrl.replace('-pooler', '');

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
  });

  let lockAcquired = false;

  try {
    await client.connect();

    // 1. Atomically try to acquire session-level advisory lock on this dedicated connection
    const res = await client.query(`SELECT pg_try_advisory_lock(${IMAP_SYNC_LOCK_KEY}) as locked`);
    lockAcquired = Boolean(res.rows[0]?.locked);

    if (!lockAcquired) {
      console.log('[CronLockService] Another instance is currently executing IMAP sync. Skipping concurrent execution.');
      return { acquired: false };
    }

    console.log('[CronLockService] Acquired dedicated PostgreSQL session advisory lock. Executing IMAP sync operation...');

    // 2. Execute operation while connection and session lock remain actively held
    const result = await fn();

    console.log('[CronLockService] IMAP sync operation completed successfully.');
    return { acquired: true, result };
  } catch (err: any) {
    console.error('[CronLockService] Error executing locked IMAP sync:', err?.message || err);
    throw err;
  } finally {
    if (lockAcquired) {
      try {
        await client.query(`SELECT pg_advisory_unlock(${IMAP_SYNC_LOCK_KEY})`);
        console.log('[CronLockService] Released PostgreSQL session advisory lock.');
      } catch (unlockErr: any) {
        console.warn('[CronLockService] Warning: Failed to explicitly unlock advisory lock (connection closing will release it):', unlockErr?.message);
      }
    }
    try {
      await client.end();
    } catch {
      // Ignore disconnect errors during teardown
    }
  }
}
