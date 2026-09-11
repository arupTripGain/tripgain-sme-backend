import { PrismaClient } from '@prisma/client';
import { PersonalizationService } from './personalizationService';

const prisma = new PrismaClient();

interface QueuedItem {
  jobId: string;
  contactId: string;
  userId?: string | undefined;
  force: boolean;
}

interface JobProgress {
  total: number;
  processed: number;
  successful: number;
  failed: number;
  aborted: boolean;
  abortReason?: string | undefined;
}

export class PersonalizationQueue {
  // Fair user queues: userId -> list of queued items
  private static userQueues: Map<string, QueuedItem[]> = new Map();
  // Job progress tracking: jobId -> progress stats
  private static jobStats: Map<string, JobProgress> = new Map();
  // Worker state flag
  private static isWorkerRunning: boolean = false;
  // Maximum global concurrent lead generations across all users
  private static get MAX_GLOBAL_CONCURRENCY(): number {
    return parseInt(process.env.AI_QUEUE_MAX_CONCURRENCY || '4', 10);
  }
  // Batch size taken per user per round-robin turn
  private static get USER_TURN_BATCH_SIZE(): number {
    return parseInt(process.env.AI_QUEUE_USER_BATCH_SIZE || '2', 10);
  }

  /**
   * Starts a background bulk personalization job.
   * Immediately enqueues items into fair multi-user queues and returns the job ID.
   */
  static async startBulkJob(params: {
    workspaceId: string;
    userId?: string;
    contactIds?: string[];
    listId?: string;
    onlyMissing?: boolean;
    force?: boolean;
  }): Promise<{ jobId: string; status: string; total: number }> {
    let targetIds: string[] = [];

    if (params.contactIds && params.contactIds.length > 0) {
      targetIds = [...params.contactIds];
    } else if (params.listId) {
      const members = await prisma.listMember.findMany({
        where: { listId: params.listId },
        select: { contactId: true }
      });
      targetIds = members.map(m => m.contactId);
    } else {
      // Default: all contacts in workspace scoped to user if provided
      const contactWhere: any = { workspaceId: params.workspaceId };
      if (params.userId) contactWhere.userId = params.userId;
      const allContacts = await prisma.contact.findMany({
        where: contactWhere,
        select: { id: true }
      });
      targetIds = allContacts.map(c => c.id);
    }

    // If onlyMissing requested, filter down
    if (params.onlyMissing) {
      const missingContacts = await prisma.contact.findMany({
        where: {
          id: { in: targetIds },
          OR: [
            { personalizedLine: null },
            { personalizedLine: '' },
            { personalizationStatus: { in: ['PENDING', 'FAILED', 'NO_USEFUL_DATA'] } }
          ]
        },
        select: { id: true }
      });
      targetIds = missingContacts.map(c => c.id);
    }

    // Create the job record in database
    const job = await prisma.personalizationJob.create({
      data: {
        workspaceId: params.workspaceId,
        userId: params.userId || null,
        status: targetIds.length === 0 ? 'COMPLETED' : 'PROCESSING',
        total: targetIds.length,
        processed: 0,
        successful: 0,
        failed: 0,
        contactIds: targetIds
      }
    });

    if (targetIds.length > 0) {
      const userKey = params.userId || 'anonymous';
      if (!this.userQueues.has(userKey)) {
        this.userQueues.set(userKey, []);
      }

      this.jobStats.set(job.id, {
        total: targetIds.length,
        processed: 0,
        successful: 0,
        failed: 0,
        aborted: false
      });

      const queue = this.userQueues.get(userKey)!;
      for (const contactId of targetIds) {
        queue.push({
          jobId: job.id,
          contactId,
          userId: params.userId,
          force: Boolean(params.force)
        });
      }

      // Trigger background fair worker loop
      this.ensureWorkerRunning();
    }

    return {
      jobId: job.id,
      status: job.status,
      total: targetIds.length
    };
  }

  /**
   * Ensures the fair round-robin worker loop is active.
   */
  private static ensureWorkerRunning(): void {
    if (this.isWorkerRunning) return;
    this.isWorkerRunning = true;

    // Run asynchronously in background without blocking caller
    (async () => {
      try {
        await this.runFairWorkerLoop();
      } catch (err) {
        console.error('[PersonalizationQueue] Fatal error in fair worker loop:', err);
      } finally {
        this.isWorkerRunning = false;
      }
    })();
  }

  /**
   * Fair Round-Robin Worker Loop:
   * Cycles through active user queues (User A -> User B -> User C -> User A...)
   * taking up to USER_TURN_BATCH_SIZE tasks per turn.
   */
  private static async runFairWorkerLoop(): Promise<void> {
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    while (this.hasPendingTasks()) {
      const userKeys = Array.from(this.userQueues.keys());

      for (const userKey of userKeys) {
        const queue = this.userQueues.get(userKey);
        if (!queue || queue.length === 0) {
          this.userQueues.delete(userKey);
          continue;
        }

        // Take small batch for this user
        const batch = queue.splice(0, this.USER_TURN_BATCH_SIZE);
        if (batch.length === 0) continue;

        // Process this user's turn
        await Promise.all(
          batch.map(async (item) => {
            const stats = this.jobStats.get(item.jobId);
            if (stats?.aborted) {
              // Skip aborted job items
              return;
            }

            try {
              const res = await PersonalizationService.generateForContact(
                item.contactId,
                item.force,
                item.userId
              );

              if (stats) {
                stats.processed++;
                if (res.success && res.personalization) {
                  stats.successful++;
                } else {
                  stats.failed++;
                  // Abort only this user's job if rate-limited or unconfigured
                  if (
                    res.code === 'AI_PROVIDER_NOT_CONFIGURED' ||
                    res.code === 'AI_USAGE_LIMIT_REACHED' ||
                    res.code === 'AI_RATE_LIMITED'
                  ) {
                    stats.aborted = true;
                    stats.abortReason = res.reason || res.code;
                    console.warn(`[PersonalizationQueue] Aborting job ${item.jobId} for user ${userKey}: ${stats.abortReason}`);
                  }
                }
              }
            } catch (err: any) {
              console.error(`[PersonalizationQueue] Error on contact ${item.contactId}:`, err?.message);
              if (stats) {
                stats.processed++;
                stats.failed++;
              }
            }

            // Sync database progress
            if (stats) {
              const isFinished = stats.processed >= stats.total || stats.aborted;
              await prisma.personalizationJob.update({
                where: { id: item.jobId },
                data: {
                  processed: stats.processed,
                  successful: stats.successful,
                  failed: stats.failed,
                  status: isFinished ? (stats.aborted ? 'FAILED' : 'COMPLETED') : 'PROCESSING',
                  updatedAt: new Date()
                }
              }).catch(() => {});

              if (isFinished) {
                this.jobStats.delete(item.jobId);
              }
            }
          })
        );

        // Small inter-batch delay to respect provider rate limits
        await sleep(150);
      }
    }
  }

  private static hasPendingTasks(): boolean {
    for (const queue of this.userQueues.values()) {
      if (queue.length > 0) return true;
    }
    return false;
  }

  /**
   * Retrieves current status of a job.
   */
  static async getJobStatus(jobId: string): Promise<any> {
    const job = await prisma.personalizationJob.findUnique({
      where: { id: jobId }
    });

    if (!job) return null;

    const progressPct = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 100;

    return {
      id: job.id,
      status: job.status,
      total: job.total,
      processed: job.processed,
      successful: job.successful,
      failed: job.failed,
      progressPct,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  }
}
