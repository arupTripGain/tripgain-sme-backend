import { PrismaClient } from '@prisma/client';
import { PersonalizationService } from './personalizationService';

const prisma = new PrismaClient();

export class PersonalizationQueue {
  private static activeJobs: Set<string> = new Set();

  /**
   * Starts a background bulk personalization job.
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
      // Launch background worker without blocking
      this.activeJobs.add(job.id);
      this.processJob(job.id, targetIds, !!params.force, params.userId).catch(err => {
        console.error(`[PersonalizationQueue] Error in job ${job.id}:`, err);
      });
    }

    return {
      jobId: job.id,
      status: job.status,
      total: targetIds.length
    };
  }

  /**
   * Worker executing batch items with controlled concurrency.
   */
  private static async processJob(
    jobId: string,
    contactIds: string[],
    force: boolean,
    userId?: string
  ): Promise<void> {
    const BATCH_SIZE = 2; // Process 2 leads at a time to stay within rate limits
    let processed = 0;
    let successful = 0;
    let failed = 0;
    let abortJob = false;

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    try {
      for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
        if (abortJob) break;
        const batch = contactIds.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async (contactId) => {
            try {
              const res = await PersonalizationService.generateForContact(contactId, force, userId);
              if (res.success && res.personalization) {
                successful++;
              } else {
                failed++;
                if (res.code === 'AI_PROVIDER_NOT_CONFIGURED' || res.code === 'AI_USAGE_LIMIT_REACHED') {
                  abortJob = true;
                }
              }
            } catch (err) {
              console.error(`[PersonalizationQueue] Failed contact ${contactId}:`, err);
              failed++;
            } finally {
              processed++;
            }
          })
        );

        // Update progress in database every batch
        await prisma.personalizationJob.update({
          where: { id: jobId },
          data: {
            processed,
            successful,
            failed,
            updatedAt: new Date()
          }
        });

        if (abortJob) {
          console.warn(`[PersonalizationQueue] Aborting job ${jobId} due to unconfigured AI provider or quota limit`);
          break;
        }

        // Small delay between batches to respect rate limits
        if (i + BATCH_SIZE < contactIds.length) {
          await sleep(300);
        }
      }

      // Mark completed or failed based on abort
      await prisma.personalizationJob.update({
        where: { id: jobId },
        data: {
          status: abortJob ? 'FAILED' : 'COMPLETED',
          processed,
          successful,
          failed,
          updatedAt: new Date()
        }
      });
    } catch (err: any) {
      console.error(`[PersonalizationQueue] Fatal error on job ${jobId}:`, err);
      await prisma.personalizationJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          processed,
          successful,
          failed,
          updatedAt: new Date()
        }
      });
    } finally {
      this.activeJobs.delete(jobId);
    }
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
