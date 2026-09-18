/**
 * ListGuard Dedicated SMTP Verification Worker
 *
 * Runs as a long-lived Node.js process on environments with open outbound TCP port 25.
 * Decoupled from the Vercel API control plane.
 *
 * Responsibilities:
 * 1. Emits regular worker heartbeats (every 15s) for health monitoring.
 * 2. Polls PostgreSQL persistent queue for QUEUED jobs with atomic leasing.
 * 3. Enforces global and per-domain concurrency rate limits.
 * 4. Integrates per-domain circuit breakers for fault isolation.
 * 5. Handles job cancellation, worker restart recovery, and idempotency.
 * 6. Safely handles shutdown on SIGINT/SIGTERM.
 */

import path from 'path';
import dotenv from 'dotenv';

// Explicitly load backend/.env BEFORE PrismaClient initialization
dotenv.config({ path: path.resolve(__dirname, '../../../backend/.env'), override: true });
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });
dotenv.config({ override: true });

import os from 'os';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { ListGuardStore, VerificationJobData } from '../services/listGuard/listGuardStore';
import { WorkerHealthService, WorkerStatus } from '../services/listGuard/workerHealth';
import { VerificationEngine, CompleteVerificationResult } from '../services/listGuard/verificationEngine';
import { RateLimiter, globalRateLimiter } from '../services/listGuard/rateLimiter';
import { normalizeEmail } from '../services/listGuard/emailNormalizer';

// Mark environment as dedicated verification worker so smtpVerifier allows live execution
process.env.LISTGUARD_WORKER = 'true';

// Safe startup diagnostic (never prints password or full url)
function logSafeDbInfo() {
  const dbUrl = process.env.DATABASE_URL || '';
  try {
    const parsed = new URL(dbUrl);
    console.log(`[ListGuard Worker DB] Host: ${parsed.hostname} | Database: ${parsed.pathname.replace(/^\//, '')} | User: ${parsed.username}`);
  } catch {
    console.warn('[ListGuard Worker DB] Warning: Unable to parse DATABASE_URL.');
  }
}
logSafeDbInfo();

interface QueueItem {
  contactId?: string | null;
  contactEmailId?: string | null;
  rawEmail: string;
  normalizedEmail: string;
  domain: string;
}

export class ListGuardWorker {
  public readonly workerId: string;
  public readonly version: string = '1.0.0';
  private prisma: PrismaClient;
  private verificationEngine: VerificationEngine;
  private rateLimiter: RateLimiter;
  private isRunning: boolean = false;
  private isDraining: boolean = false;
  private status: WorkerStatus = 'ONLINE';
  private startedAt: Date;
  private processedCount: number = 0;
  private currentJobId: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options?: {
    workerId?: string;
    prisma?: PrismaClient;
    rateLimiter?: RateLimiter;
  }) {
    this.workerId =
      options?.workerId ||
      `worker-${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    this.prisma = options?.prisma || new PrismaClient();
    this.rateLimiter = options?.rateLimiter || globalRateLimiter;
    this.verificationEngine = new VerificationEngine(this.prisma);
    this.startedAt = new Date();
  }

  /**
   * Starts the worker processing loop and heartbeat emitter.
   */
  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isDraining = false;
    this.status = 'ONLINE';

    console.log(`[ListGuard Worker] Initializing worker ${this.workerId} (v${this.version})...`);

    // 1. Initial Heartbeat registration
    try {
      await this.sendHeartbeat();
    } catch (err: any) {
      console.warn(`[ListGuard Worker] Initial heartbeat warning:`, err?.message);
    }

    // 2. Schedule regular heartbeats every 30 seconds
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch(err => {
        console.error(`[ListGuard Worker Heartbeat Error]:`, err?.message);
      });
    }, 30000);

    // 3. Start main polling loop
    this.pollLoop().catch(err => {
      console.error(`[ListGuard Worker Fatal Loop Error]:`, err);
    });
  }

  /**
   * Gracefully drains active tasks and shuts down the worker.
   */
  public async stop(): Promise<void> {
    console.log(`[ListGuard Worker] Stopping worker ${this.workerId}...`);
    this.isDraining = true;
    this.status = 'DRAINING';
    await this.sendHeartbeat();

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Release current job lock if held
    if (this.currentJobId) {
      try {
        await ListGuardStore.releaseJobLock(this.prisma, this.currentJobId);
      } catch {}
    }

    this.isRunning = false;
    this.status = 'OFFLINE';
    await WorkerHealthService.markWorkerOffline(this.prisma, this.workerId);
    console.log(`[ListGuard Worker] Worker ${this.workerId} successfully stopped.`);
  }

  /**
   * Emits a single worker heartbeat to the persistent store.
   */
  private async sendHeartbeat(): Promise<void> {
    await WorkerHealthService.registerHeartbeat(this.prisma, {
      workerId: this.workerId,
      version: this.version,
      status: this.status,
      hostname: os.hostname(),
      startedAt: this.startedAt,
      lastHeartbeatAt: new Date(),
      activeJobs: this.currentJobId ? 1 : 0,
      processedCount: this.processedCount,
      currentJobId: this.currentJobId
    });
  }

  /**
   * Main polling loop: claims pending jobs and processes them.
   * Uses adaptive idle backoff: 2.5s -> 5s -> 10s -> 15s -> 30s (max 30s)
   */
  private async pollLoop(): Promise<void> {
    console.log(`[ListGuard Worker] Polling loop started for worker ${this.workerId}.`);
    const BACKOFF_SCHEDULE = [2500, 5000, 10000, 15000, 30000];
    let idleLevel = 0;
    let idleLogCount = 0;

    while (this.isRunning && !this.isDraining) {
      try {
        if (idleLogCount % 20 === 0) {
          console.log(`[ListGuard Worker Poll] Querying PostgreSQL for next pending job (backoff interval: ${BACKOFF_SCHEDULE[idleLevel]}ms)...`);
        }
        const job = await ListGuardStore.claimNextJob(this.prisma, this.workerId);

        if (job) {
          // Immediately reset backoff to 2.5s upon claiming a job
          idleLevel = 0;
          idleLogCount = 0;
          this.currentJobId = job.id;
          this.status = 'BUSY';
          await this.sendHeartbeat();

          console.log(`[ListGuard Worker] Successfully claimed job ${job.id} (List: ${job.listId}). Starting processing...`);
          try {
            await this.processJob(job);
            console.log(`[ListGuard Worker] Job ${job.id} processing completed.`);
          } catch (jobErr: any) {
            console.error(`[ListGuard Worker] Job ${job.id} processing failed with error:`, jobErr?.message);
          }

          this.currentJobId = null;
          this.status = 'ONLINE';
          await this.sendHeartbeat();
        } else {
          // No jobs available; advance backoff schedule up to 30s maximum
          const sleepMs = BACKOFF_SCHEDULE[idleLevel];
          if (idleLevel < BACKOFF_SCHEDULE.length - 1) {
            idleLevel++;
          }
          idleLogCount++;
          await new Promise(resolve => setTimeout(resolve, sleepMs));
        }
      } catch (err: any) {
        console.error(`[ListGuard Worker Poll Error]:`, err?.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  /**
   * Processes a claimed verification job to completion with idempotency and cancellation awareness.
   */
  public async processJob(job: VerificationJobData): Promise<void> {
    const jobId = job.id;

    // 1. Fetch List and Members
    const list = await this.prisma.list.findUnique({
      where: { id: job.listId },
      include: {
        members: {
          include: {
            contact: {
              include: {
                emails: true
              }
            }
          }
        }
      }
    });

    if (!list) {
      console.warn(`[ListGuard Worker] List ${job.listId} not found. Failing job ${jobId}.`);
      await ListGuardStore.updateJob(this.prisma, jobId, {
        status: 'FAILED',
        error: 'Target list not found',
        completedAt: new Date()
      });
      return;
    }

    // 2. Extract and deduplicate items
    const rawItems: QueueItem[] = [];
    const seenEmails = new Set<string>();

    for (const member of list.members) {
      const contact = member.contact;
      if (!contact) continue;

      const emails = contact.emails || [];
      const primaryEmail = emails.find(e => e.isPrimary) || emails[0];
      const emailStr = primaryEmail?.email;

      if (emailStr) {
        const norm = normalizeEmail(emailStr);
        if (norm.normalizedEmail && !seenEmails.has(norm.normalizedEmail)) {
          seenEmails.add(norm.normalizedEmail);
          rawItems.push({
            contactId: contact.id,
            contactEmailId: primaryEmail?.id,
            rawEmail: norm.rawEmail,
            normalizedEmail: norm.normalizedEmail,
            domain: norm.domain
          });
        }
      }
    }

    // 3. Idempotency & Restart Recovery: check what records are already verified for this job
    const completedSet = await ListGuardStore.getCompletedEmailSetForJob(this.prisma, jobId);
    const pendingItems = rawItems.filter(item => !completedSet.has(item.normalizedEmail));

    console.log(
      `[ListGuard Worker] Job ${jobId}: Total ${rawItems.length} items. Already verified: ${completedSet.size}. Pending: ${pendingItems.length}.`
    );

    // Sync initial job counters based on already verified items
    let processed = completedSet.size;
    let deliverable = 0;
    let undeliverable = 0;
    let catchAll = 0;
    let unknown = 0;
    let reusedFromCache = 0;

    // Read existing counts if resuming
    if (completedSet.size > 0) {
      const existingResults = await ListGuardStore.getAllResultsForJob(this.prisma, jobId);
      for (const r of existingResults) {
        if (r.result === 'DELIVERABLE') deliverable++;
        else if (r.result === 'UNDELIVERABLE') undeliverable++;
        else if (r.result === 'CATCH_ALL') catchAll++;
        else unknown++;
      }
    }

    if (pendingItems.length === 0) {
      // All items were already finished
      await ListGuardStore.updateJob(this.prisma, jobId, {
        status: 'COMPLETED',
        total: rawItems.length,
        processed,
        deliverable,
        undeliverable,
        catchAll,
        unknown,
        reusedFromCache,
        completedAt: new Date()
      });
      await ListGuardStore.releaseJobLock(this.prisma, jobId);
      return;
    }

    // 4. Process pending items with bounded concurrency (parallel pool)
    let lastLockRenew = Date.now();
    const maxGlobal = this.rateLimiter.getStats().maxGlobal || 6;
    let itemIndex = 0;
    let isJobCancelled = false;
    let lastCancellationCheck = 0;

    const workerTask = async () => {
      while (!this.isDraining && !isJobCancelled) {
        // Synchronously grab next item index to eliminate race conditions among concurrent workers
        const currentIndex = itemIndex++;
        if (currentIndex >= pendingItems.length) break;

        const item = pendingItems[currentIndex]!;

        // Instant cancellation check on every item iteration
        const latestJob = await ListGuardStore.findJobById(this.prisma, jobId);
        if (latestJob?.status === 'CANCELLED') {
          isJobCancelled = true;
          console.log(`[ListGuard Worker] Job ${jobId} was CANCELLED. Halting processing.`);
          break;
        }

        // Periodic lock renewal check
        if (Date.now() - lastLockRenew > 120000) {
          await ListGuardStore.renewJobLock(this.prisma, jobId, this.workerId);
          lastLockRenew = Date.now();
        }

        if (isJobCancelled) break;

        // Wait for concurrency slot (global max 6, per-domain max 2)
        await this.rateLimiter.waitForSlot(item.domain);

        if (isJobCancelled) {
          this.rateLimiter.release(item.domain);
          break;
        }

        try {
          let verification: CompleteVerificationResult;

          try {
            verification = await this.verificationEngine.verifyEmail({
              rawEmail: item.rawEmail,
              userId: job.createdByUserId,
              contactId: item.contactId || undefined,
              contactEmailId: item.contactEmailId || undefined
            });
          } catch (err: any) {
            // Graceful fallback to UNKNOWN: individual record failure NEVER crashes job
            const now = new Date();
            verification = {
              email: item.rawEmail,
              normalizedEmail: item.normalizedEmail,
              result: 'UNKNOWN',
              verificationReason: 'UNKNOWN',
              confidence: 'LOW',
              syntaxStatus: 'PASS',
              domainStatus: 'UNKNOWN',
              mxStatus: 'UNKNOWN',
              smtpStatus: 'UNKNOWN',
              isCatchAll: false,
              isDisposable: false,
              isRole: false,
              suppressionStatus: null,
              bounceStatus: null,
              smtpResponseCode: null,
              smtpResponse: err?.message || 'Verification exception occurred',
              reusedFromCache: false,
              verifiedAt: now,
              expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
            };
          }

          if (isJobCancelled) break;

          // Persist result record
          await ListGuardStore.createResult(this.prisma, {
            jobId,
            contactId: item.contactId || null,
            contactEmailId: item.contactEmailId || null,
            email: verification.email,
            normalizedEmail: verification.normalizedEmail,
            result: verification.result,
            verificationReason: verification.verificationReason || 'UNKNOWN',
            confidence: verification.confidence || 'HIGH',
            syntaxStatus: verification.syntaxStatus,
            domainStatus: verification.domainStatus,
            mxStatus: verification.mxStatus,
            smtpStatus: verification.smtpStatus,
            isCatchAll: verification.isCatchAll,
            isDisposable: verification.isDisposable,
            isRole: verification.isRole,
            suppressionStatus: verification.suppressionStatus,
            bounceStatus: verification.bounceStatus,
            smtpResponseCode: verification.smtpResponseCode,
            smtpResponse: verification.smtpResponse,
            verifiedAt: verification.verifiedAt,
            expiresAt: verification.expiresAt
          });

          // Update counters
          processed++;
          this.processedCount++;
          if (verification.reusedFromCache) reusedFromCache++;
          if (verification.result === 'DELIVERABLE') deliverable++;
          else if (verification.result === 'UNDELIVERABLE') undeliverable++;
          else if (verification.result === 'CATCH_ALL') catchAll++;
          else unknown++;

          // Update progress in PostgreSQL every 10 items or on completion
          const isFinished = processed >= rawItems.length;
          if (processed % 10 === 0 || isFinished) {
            await ListGuardStore.updateJob(this.prisma, jobId, {
              total: rawItems.length,
              processed,
              deliverable,
              undeliverable,
              catchAll,
              unknown,
              reusedFromCache,
              status: isFinished ? 'COMPLETED' : 'RUNNING',
              completedAt: isFinished ? new Date() : null
            });
          }
        } finally {
          this.rateLimiter.release(item.domain);
        }
      }
    };

    // Dispatch concurrent worker pool tasks
    const poolWorkers: Promise<void>[] = [];
    for (let w = 0; w < maxGlobal; w++) {
      poolWorkers.push(workerTask());
    }
    await Promise.all(poolWorkers);

    // Check if job was cancelled
    const finalCheck = await ListGuardStore.findJobById(this.prisma, jobId);
    if (isJobCancelled || finalCheck?.status === 'CANCELLED') {
      console.log(`[ListGuard Worker] Job ${jobId} was CANCELLED. Not marking as COMPLETED.`);
      await ListGuardStore.releaseJobLock(this.prisma, jobId);
      return;
    }

    // 5. Finalize Job
    await ListGuardStore.updateJob(this.prisma, jobId, {
      total: rawItems.length,
      processed,
      deliverable,
      undeliverable,
      catchAll,
      unknown,
      reusedFromCache,
      status: 'COMPLETED',
      completedAt: new Date()
    });

    await ListGuardStore.releaseJobLock(this.prisma, jobId);
    console.log(
      `[ListGuard Worker] Job ${jobId} COMPLETED. Results: ${deliverable} deliverable, ${undeliverable} undeliverable, ${catchAll} catch-all, ${unknown} unknown.`
    );
  }
}

// Standalone execution entrypoint
if (require.main === module) {
  const worker = new ListGuardWorker();

  const handleShutdown = async (signal: string) => {
    console.log(`\n[ListGuard Worker] Received ${signal}. Shutting down gracefully...`);
    await worker.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  worker.start().catch(err => {
    console.error('[ListGuard Worker Fatal Error]:', err);
    process.exit(1);
  });
}
