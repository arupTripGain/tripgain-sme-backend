import { PrismaClient } from '@prisma/client';
import { processLeadIntelligencePipeline } from './leadIntelligencePipeline';

const prisma = new PrismaClient();

export interface EnqueueBatchParams {
  batchId: string;
  sourceId: string;
  userId: string;
  workspaceId?: string | null | undefined;
  url: string;
  sourceName?: string | undefined;
  maxRecords?: number | undefined;
  maxPages?: number | undefined;
  maxDetailPages?: number | undefined;
  maxRequests?: number | undefined;
  mode?: 'sample' | 'limited' | 'all' | undefined;
}

export class BatchQueueService {
  // In-memory set of currently active batch IDs to prevent duplicate concurrent executions
  private static activeBatches = new Set<string>();

  // In-memory queue of pending batch jobs
  private static pendingQueue: EnqueueBatchParams[] = [];

  // Flag indicating whether the worker loop is running
  private static isWorkerLoopActive = false;

  /**
   * Enqueues a research batch for persistent background execution.
   * Updates PostgreSQL status to QUEUED and starts background worker loop.
   */
  public static async enqueueBatch(params: EnqueueBatchParams): Promise<{ batchId: string; status: string }> {
    // 1. Ensure batch is marked QUEUED in database
    await prisma.leadIntelligenceResearchBatch.update({
      where: { id: params.batchId },
      data: {
        status: 'QUEUED',
        errorMessage: null,
      },
    }).catch((err) => {
      console.warn(`[BatchQueueService] Error setting initial batch status for ${params.batchId}:`, err);
    });

    // 2. Add to pending queue if not already queued or active
    const isAlreadyQueued = this.pendingQueue.some((item) => item.batchId === params.batchId);
    if (!isAlreadyQueued && !this.activeBatches.has(params.batchId)) {
      this.pendingQueue.push(params);
    }

    // 3. Trigger worker loop asynchronously (does not block caller)
    this.ensureWorkerLoop();

    return {
      batchId: params.batchId,
      status: 'QUEUED',
    };
  }

  public static getActiveBatchCount(): number {
    return this.activeBatches.size;
  }

  public static getPendingQueueCount(): number {
    return this.pendingQueue.length;
  }

  /**
   * Recovers any batches left orphaned or interrupted from server reloads.
   */
  public static async recoverStalledBatches(): Promise<number> {
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const stalledBatches = await prisma.leadIntelligenceResearchBatch.findMany({
        where: {
          status: { in: ['QUEUED', 'DISCOVERING', 'EXTRACTING', 'NORMALIZING', 'DEDUPLICATING', 'RESOLVING'] },
          createdAt: { lt: fiveMinutesAgo },
        },
        take: 10,
      });

      let recovered = 0;
      for (const batch of stalledBatches) {
        if (!this.activeBatches.has(batch.id) && batch.sourceUrl) {
          console.log(`[BatchQueueService] Recovering stalled research batch: ${batch.id} (${batch.name})`);
          await this.enqueueBatch({
            batchId: batch.id,
            sourceId: batch.sourceId || batch.id,
            userId: batch.userId,
            workspaceId: batch.workspaceId,
            url: batch.sourceUrl,
            sourceName: batch.name,
          });
          recovered++;
        }
      }
      return recovered;
    } catch (err: any) {
      console.warn('[BatchQueueService] Error checking stalled batches:', err?.message);
      return 0;
    }
  }

  /**
   * Ensures the background queue processing loop is actively running.
   */
  private static ensureWorkerLoop(): void {
    if (this.isWorkerLoopActive) return;
    this.isWorkerLoopActive = true;

    // Run asynchronously in the background
    (async () => {
      try {
        await this.runWorkerLoop();
      } catch (err) {
        console.error('[BatchQueueService] Unhandled error in background worker loop:', err);
      } finally {
        this.isWorkerLoopActive = false;
        // If items arrived while exiting, re-arm
        if (this.pendingQueue.length > 0) {
          this.ensureWorkerLoop();
        }
      }
    })();
  }

  /**
   * Background worker loop that sequentially processes queued research batches.
   */
  private static async runWorkerLoop(): Promise<void> {
    while (this.pendingQueue.length > 0) {
      const job = this.pendingQueue.shift();
      if (!job) continue;

      if (this.activeBatches.has(job.batchId)) {
        continue; // Already being processed
      }

      this.activeBatches.add(job.batchId);

      try {
        // Verify batch has not been cancelled before starting
        const currentBatch = await prisma.leadIntelligenceResearchBatch.findUnique({
          where: { id: job.batchId },
          select: { status: true },
        });

        if (currentBatch?.status === 'CANCELLED') {
          console.log(`[BatchQueueService] Batch ${job.batchId} was cancelled before starting; skipping.`);
          this.activeBatches.delete(job.batchId);
          continue;
        }

        console.log(`[BatchQueueService] Starting execution of research batch: ${job.batchId} (${job.url})`);

        // Execute the pipeline
        await processLeadIntelligencePipeline({
          batchId: job.batchId,
          sourceId: job.sourceId,
          userId: job.userId,
          workspaceId: job.workspaceId || null,
          url: job.url,
          sourceName: job.sourceName || 'Exhibitor Research',
          sourceType: 'WEBSITE',
          maxRecords: job.maxRecords,
          maxPages: job.maxPages,
          maxDetailPages: job.maxDetailPages,
          maxRequests: job.maxRequests,
          mode: job.mode,
        });

        console.log(`[BatchQueueService] Successfully finished research batch: ${job.batchId}`);
      } catch (err: any) {
        console.error(`[BatchQueueService] Error processing research batch ${job.batchId}:`, err);
        await prisma.leadIntelligenceResearchBatch.update({
          where: { id: job.batchId },
          data: {
            status: 'FAILED',
            errorMessage: err?.message || 'Unexpected background extraction error',
            completedAt: new Date(),
          },
        }).catch(() => {});
      } finally {
        this.activeBatches.delete(job.batchId);
      }
    }
  }

  /**
   * Checks if a batch is currently actively executing
   */
  public static isBatchActive(batchId: string): boolean {
    return this.activeBatches.has(batchId);
  }
}
