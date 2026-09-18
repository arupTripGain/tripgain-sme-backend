import { PrismaClient } from '@prisma/client';
import { normalizeEmail } from './emailNormalizer';
import { ListGuardStore, VerificationJobData } from './listGuardStore';
import { WorkerHealthService } from './workerHealth';
import { ListGuardWorker } from '../../workers/listGuardWorker';

const prisma = new PrismaClient();

export class ListGuardQueue {
  /**
   * Enqueues a verification job for a given List into the persistent queue.
   * CRITICAL ARCHITECTURAL RULE:
   * The API process creates the QUEUED job record in PostgreSQL.
   * On Vercel / Production Serverless: Vercel API NEVER executes SMTP verification.
   * Execution is performed by the dedicated worker process.
   * In local development / test suites: if no standalone worker is active,
   * dispatches the ListGuardWorker to process the job in the background.
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
    const seenNormalizedEmails = new Set<string>();
    let totalItems = 0;

    for (const member of list.members) {
      const contact = member.contact;
      if (!contact) continue;

      const emails = contact.emails || [];
      const primaryEmail = emails.find(e => e.isPrimary) || emails[0];
      const emailStr = primaryEmail?.email;

      if (emailStr) {
        const norm = normalizeEmail(emailStr);
        if (norm.normalizedEmail && !seenNormalizedEmails.has(norm.normalizedEmail)) {
          seenNormalizedEmails.add(norm.normalizedEmail);
          totalItems++;
        }
      }
    }

    // 3. Create the EmailVerificationJob record in persistent PostgreSQL queue
    const isZeroItems = totalItems === 0;
    const job = await ListGuardStore.createJob(prisma, {
      listId: list.id,
      createdByUserId: params.userId,
      status: isZeroItems ? 'COMPLETED' : 'QUEUED',
      total: totalItems,
      processed: 0,
      deliverable: 0,
      undeliverable: 0,
      catchAll: 0,
      unknown: 0,
      reusedFromCache: 0,
      startedAt: null,
      completedAt: isZeroItems ? new Date() : null
    });

    if (isZeroItems) {
      return {
        jobId: job.id,
        status: 'COMPLETED',
        total: 0
      };
    }

    // 4. In Vercel serverless environment, execution stops here.
    // The job remains QUEUED in PostgreSQL for the dedicated worker to claim.
    if (process.env.VERCEL) {
      return {
        jobId: job.id,
        status: 'QUEUED',
        total: totalItems
      };
    }

    // 5. In local development or test suites: if no standalone worker is currently reporting heartbeats,
    // dispatch a dedicated ListGuardWorker instance to process the job in the background.
    WorkerHealthService.getWorkerHealthStatus(prisma, 10000).then(health => {
      if (!health.available) {
        const worker = new ListGuardWorker({ prisma });
        worker.processJob(job).catch(err => {
          console.error('[ListGuardQueue Local Worker Error]:', err);
        });
      }
    }).catch(() => {});

    return {
      jobId: job.id,
      status: 'QUEUED',
      total: totalItems
    };
  }

  /**
   * Cancels a running or queued job persistently in PostgreSQL.
   */
  public static async cancelJob(jobId: string, userId: string): Promise<boolean> {
    const job = await ListGuardStore.findJobById(prisma, jobId, userId);
    if (!job) return false;

    if (job.status === 'COMPLETED' || job.status === 'FAILED') {
      return false;
    }

    await ListGuardStore.updateJob(prisma, jobId, {
      status: 'CANCELLED',
      completedAt: new Date()
    });

    return true;
  }

  /**
   * Retrieves current progress stats and unknown reason breakdown for a job.
   */
  public static async getJobProgress(jobId: string, userId: string): Promise<any> {
    const dbJob = await ListGuardStore.findJobById(prisma, jobId, userId);
    if (!dbJob) return null;

    const list = await prisma.list.findUnique({
      where: { id: dbJob.listId },
      select: { id: true, name: true }
    });

    const unknownReasons = await ListGuardStore.getJobUnknownReasonDistribution(prisma, jobId);

    return {
      id: dbJob.id,
      listId: dbJob.listId,
      listName: list?.name || 'Unknown List',
      status: dbJob.status,
      total: dbJob.total,
      processed: dbJob.processed,
      deliverable: dbJob.deliverable,
      undeliverable: dbJob.undeliverable,
      catchAll: dbJob.catchAll,
      unknown: dbJob.unknown,
      reusedFromCache: dbJob.reusedFromCache,
      unknownReasons,
      error: dbJob.error,
      startedAt: dbJob.startedAt,
      completedAt: dbJob.completedAt,
      createdAt: dbJob.createdAt
    };
  }
}
