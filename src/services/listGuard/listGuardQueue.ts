import { PrismaClient } from '@prisma/client';
import { VerificationEngine, CompleteVerificationResult } from './verificationEngine';
import { normalizeEmail } from './emailNormalizer';
import { ListGuardStore } from './listGuardStore';

const prisma = new PrismaClient();
const verificationEngine = new VerificationEngine(prisma);

interface QueueItem {
  jobId: string;
  userId: string;
  contactId?: string | undefined;
  contactEmailId?: string | undefined;
  email: string;
  normalizedEmail: string;
  domain: string;
}

interface JobProgressStats {
  total: number;
  processed: number;
  deliverable: number;
  undeliverable: number;
  catchAll: number;
  unknown: number;
  reusedFromCache: number;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  cancelled: boolean;
  error?: string;
}

export class ListGuardQueue {
  // Fair user queues: userId -> list of queued items
  private static userQueues: Map<string, QueueItem[]> = new Map();
  // Live job stats cache for high frequency frontend polling: jobId -> stats
  private static activeJobs: Map<string, JobProgressStats> = new Map();
  // Track active domains being checked to bound per-domain concurrency
  private static activeDomains: Map<string, number> = new Map();
  // Concurrency counters
  private static currentGlobalConcurrency: number = 0;
  private static isWorkerRunning: boolean = false;

  private static get MAX_GLOBAL_CONCURRENCY(): number {
    return parseInt(process.env.LISTGUARD_MAX_CONCURRENCY || '6', 10);
  }

  private static get MAX_PER_DOMAIN_CONCURRENCY(): number {
    return parseInt(process.env.LISTGUARD_PER_DOMAIN_CONCURRENCY || '2', 10);
  }

  /**
   * Initializes and enqueues a verification job for a given List.
   */
  public static async startJob(params: {
    listId: string;
    userId: string;
    forceReverify?: boolean;
  }): Promise<{ jobId: string; status: string; total: number }> {
    // 1. Fetch list and members
    const list = await prisma.list.findFirst({
      where: { id: params.listId, userId: params.userId },
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
      throw new Error('List not found or unauthorized');
    }

    // 2. Extract and deduplicate emails from list members
    const rawItems: Array<{
      contactId?: string | undefined;
      contactEmailId?: string | undefined;
      email: string;
      normalizedEmail: string;
      domain: string;
    }> = [];

    const seenNormalizedEmails = new Set<string>();

    for (const member of list.members) {
      const contact = member.contact;
      if (!contact) continue;

      const emails = contact.emails || [];
      // Pick primary email first, or first available email
      const primaryEmail = emails.find(e => e.isPrimary) || emails[0];
      const emailStr = primaryEmail?.email;

      if (emailStr) {
        const norm = normalizeEmail(emailStr);
        if (norm.normalizedEmail && !seenNormalizedEmails.has(norm.normalizedEmail)) {
          seenNormalizedEmails.add(norm.normalizedEmail);
          rawItems.push({
            contactId: contact.id,
            contactEmailId: primaryEmail?.id,
            email: norm.rawEmail,
            normalizedEmail: norm.normalizedEmail,
            domain: norm.domain
          });
        }
      }
    }

    // 3. Create the EmailVerificationJob record
    const job = await ListGuardStore.createJob(prisma, {
      listId: list.id,
      createdByUserId: params.userId,
      status: rawItems.length === 0 ? 'COMPLETED' : 'QUEUED',
      total: rawItems.length,
      processed: 0,
      deliverable: 0,
      undeliverable: 0,
      catchAll: 0,
      unknown: 0,
      reusedFromCache: 0,
      startedAt: rawItems.length > 0 ? new Date() : null,
      completedAt: rawItems.length === 0 ? new Date() : null
    });

    const jobStats: JobProgressStats = {
      total: rawItems.length,
      processed: 0,
      deliverable: 0,
      undeliverable: 0,
      catchAll: 0,
      unknown: 0,
      reusedFromCache: 0,
      status: rawItems.length === 0 ? 'COMPLETED' : 'QUEUED',
      cancelled: false
    };

    this.activeJobs.set(job.id, jobStats);

    if (rawItems.length === 0) {
      return { jobId: job.id, status: 'COMPLETED', total: 0 };
    }

    // 4. Enqueue into fair user queue
    if (!this.userQueues.has(params.userId)) {
      this.userQueues.set(params.userId, []);
    }
    const userQueue = this.userQueues.get(params.userId)!;

    for (const item of rawItems) {
      userQueue.push({
        jobId: job.id,
        userId: params.userId,
        contactId: item.contactId,
        contactEmailId: item.contactEmailId,
        email: item.email,
        normalizedEmail: item.normalizedEmail,
        domain: item.domain
      });
    }

    // 5. Trigger background worker loop
    this.ensureWorkerRunning();

    return {
      jobId: job.id,
      status: 'QUEUED',
      total: rawItems.length
    };
  }

  /**
   * Cancels a running or queued job.
   */
  public static async cancelJob(jobId: string, userId: string): Promise<boolean> {
    const job = await ListGuardStore.findJobById(prisma, jobId, userId);

    if (!job) return false;

    // Remove pending items for this jobId from the user's queue
    const queue = this.userQueues.get(userId);
    if (queue) {
      this.userQueues.set(
        userId,
        queue.filter(item => item.jobId !== jobId)
      );
    }

    const stats = this.activeJobs.get(jobId);
    if (stats) {
      stats.cancelled = true;
      stats.status = 'CANCELLED';
    }

    await ListGuardStore.updateJob(prisma, jobId, {
      status: 'CANCELLED',
      completedAt: new Date()
    });

    return true;
  }

  /**
   * Retrieves live progress stats for a job.
   */
  public static async getJobProgress(jobId: string, userId: string): Promise<any> {
    // Check in-memory first for real-time responsiveness
    const inMem = this.activeJobs.get(jobId);
    
    const dbJob = await ListGuardStore.findJobById(prisma, jobId, userId);

    if (!dbJob) return null;

    const list = await prisma.list.findUnique({
      where: { id: dbJob.listId },
      select: { id: true, name: true }
    });

    return {
      id: dbJob.id,
      listId: dbJob.listId,
      listName: list?.name || 'Unknown List',
      status: inMem?.status || dbJob.status,
      total: inMem?.total ?? dbJob.total,
      processed: inMem?.processed ?? dbJob.processed,
      deliverable: inMem?.deliverable ?? dbJob.deliverable,
      undeliverable: inMem?.undeliverable ?? dbJob.undeliverable,
      catchAll: inMem?.catchAll ?? dbJob.catchAll,
      unknown: inMem?.unknown ?? dbJob.unknown,
      reusedFromCache: inMem?.reusedFromCache ?? dbJob.reusedFromCache,
      error: inMem?.error || dbJob.error,
      startedAt: dbJob.startedAt,
      completedAt: dbJob.completedAt,
      createdAt: dbJob.createdAt
    };
  }

  /**
   * Ensures the background worker loop is running.
   */
  private static ensureWorkerRunning(): void {
    if (this.isWorkerRunning) return;
    this.isWorkerRunning = true;
    this.workerLoop().catch(err => {
      console.error('[ListGuardQueue workerLoop Error]:', err);
      this.isWorkerRunning = false;
    });
  }

  /**
   * Main asynchronous queue worker loop with round-robin fair user scheduling
   * and bounded global & per-domain concurrency.
   */
  private static async workerLoop(): Promise<void> {
    while (true) {
      // Find all user queues with pending items
      const activeUserIds = Array.from(this.userQueues.keys()).filter(
        uid => (this.userQueues.get(uid)?.length || 0) > 0
      );

      if (activeUserIds.length === 0 && this.currentGlobalConcurrency === 0) {
        this.isWorkerRunning = false;
        break;
      }

      if (this.currentGlobalConcurrency >= this.MAX_GLOBAL_CONCURRENCY) {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }

      let itemPicked = false;

      for (const userId of activeUserIds) {
        const queue = this.userQueues.get(userId);
        if (!queue || queue.length === 0) continue;

        // Check per-domain concurrency for the next candidate
        const candidateIndex = queue.findIndex(item => {
          const domainActive = this.activeDomains.get(item.domain) || 0;
          return domainActive < this.MAX_PER_DOMAIN_CONCURRENCY;
        });

        if (candidateIndex === -1) {
          // All pending domains for this user are currently at capacity; try next user
          continue;
        }

        const [item] = queue.splice(candidateIndex, 1);
        if (!item) continue;

        // Check if job was cancelled
        const stats = this.activeJobs.get(item.jobId);
        if (stats?.cancelled) {
          continue;
        }

        // Increment concurrency trackers
        this.currentGlobalConcurrency++;
        this.activeDomains.set(
          item.domain,
          (this.activeDomains.get(item.domain) || 0) + 1
        );

        if (stats && stats.status === 'QUEUED') {
          stats.status = 'RUNNING';
          ListGuardStore.updateJob(prisma, item.jobId, { status: 'RUNNING', startedAt: new Date() }).catch(() => {});
        }

        // Process item asynchronously without blocking the loop
        this.processQueueItem(item)
          .finally(() => {
            this.currentGlobalConcurrency--;
            const count = (this.activeDomains.get(item.domain) || 1) - 1;
            if (count <= 0) {
              this.activeDomains.delete(item.domain);
            } else {
              this.activeDomains.set(item.domain, count);
            }
          })
          .catch(err => {
            console.error(`[ListGuardQueue processQueueItem Error for ${item.email}]:`, err);
          });

        itemPicked = true;
        if (this.currentGlobalConcurrency >= this.MAX_GLOBAL_CONCURRENCY) {
          break;
        }
      }

      if (!itemPicked) {
        await new Promise(r => setTimeout(r, 150));
      }
    }
  }

  /**
   * Processes a single email verification item, updates database and memory stats.
   * A single bad email NEVER fails the job.
   */
  private static async processQueueItem(item: QueueItem): Promise<void> {
    const stats = this.activeJobs.get(item.jobId);
    if (stats?.cancelled) return;

    let verification: CompleteVerificationResult;

    try {
      verification = await verificationEngine.verifyEmail({
        rawEmail: item.email,
        userId: item.userId,
        contactId: item.contactId,
        contactEmailId: item.contactEmailId
      });
    } catch (err: any) {
      // Graceful fallback to UNKNOWN on unhandled error
      const now = new Date();
      verification = {
        email: item.email,
        normalizedEmail: item.normalizedEmail,
        result: 'UNKNOWN',
        syntaxStatus: 'PASS',
        domainStatus: 'UNKNOWN',
        mxStatus: 'UNKNOWN',
        smtpStatus: 'UNKNOWN',
        isCatchAll: false,
        isDisposable: false,
        isRole: false,
        suppressionStatus: null,
        bounceStatus: null,
        verificationReason: 'UNKNOWN',
        smtpResponseCode: null,
        smtpResponse: err?.message || 'Verification exception encountered',
        reusedFromCache: false,
        verifiedAt: now,
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
      };
    }

    // Persist result record
    await ListGuardStore.createResult(prisma, {
      jobId: item.jobId,
      contactId: item.contactId || null,
      contactEmailId: item.contactEmailId || null,
      email: verification.email,
      normalizedEmail: verification.normalizedEmail,
      result: verification.result,
      verificationReason: verification.verificationReason || 'UNKNOWN',
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

    // Update in-memory stats
    if (stats && !stats.cancelled) {
      stats.processed++;
      if (verification.reusedFromCache) stats.reusedFromCache++;
      if (verification.result === 'DELIVERABLE') stats.deliverable++;
      else if (verification.result === 'UNDELIVERABLE') stats.undeliverable++;
      else if (verification.result === 'CATCH_ALL') stats.catchAll++;
      else stats.unknown++;

      const isFinished = stats.processed >= stats.total;
      if (isFinished) {
        stats.status = 'COMPLETED';
      }

      // Sync progress to DB
      await ListGuardStore.updateJob(prisma, item.jobId, {
        processed: stats.processed,
        deliverable: stats.deliverable,
        undeliverable: stats.undeliverable,
        catchAll: stats.catchAll,
        unknown: stats.unknown,
        reusedFromCache: stats.reusedFromCache,
        status: isFinished ? 'COMPLETED' : 'RUNNING',
        completedAt: isFinished ? new Date() : null
      });
    }
  }
}
