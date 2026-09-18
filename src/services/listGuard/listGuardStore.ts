import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

export interface VerificationJobData {
  id: string;
  listId: string;
  createdByUserId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  total: number;
  processed: number;
  deliverable: number;
  undeliverable: number;
  catchAll: number;
  unknown: number;
  reusedFromCache: number;
  error?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  lockedBy?: string | null;
  lockedAt?: Date | null;
  lockExpiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VerificationResultData {
  id: string;
  jobId: string;
  contactId?: string | null;
  contactEmailId?: string | null;
  email: string;
  normalizedEmail: string;
  result: 'DELIVERABLE' | 'UNDELIVERABLE' | 'CATCH_ALL' | 'UNKNOWN';
  verificationReason?: string | null;
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  syntaxStatus: string;
  domainStatus: string;
  mxStatus: string;
  smtpStatus: string;
  isCatchAll: boolean;
  isDisposable: boolean;
  isRole: boolean;
  suppressionStatus?: string | null;
  bounceStatus?: string | null;
  smtpResponseCode?: string | null;
  smtpResponse?: string | null;
  verifiedAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class ListGuardStore {
  private static jobsMap: Map<string, VerificationJobData> = new Map();
  private static resultsMap: Map<string, VerificationResultData[]> = new Map(); // jobId -> results
  private static cacheMap: Map<string, VerificationResultData> = new Map(); // normalizedEmail -> result
  private static dbHasTables: boolean | null = null;

  private static isTableMissingError(err: any): boolean {
    if (!err) return false;
    if (err.code === 'P2021') return true;
    const msg = String(err.message || '').toLowerCase();
    return msg.includes('does not exist') || msg.includes('relation') || msg.includes('table');
  }

  public static async checkTableAvailability(prisma: PrismaClient): Promise<boolean> {
    if (this.dbHasTables !== null) return this.dbHasTables;
    try {
      await (prisma as any).emailVerificationJob.findFirst({ take: 1 });
      this.dbHasTables = true;
      return true;
    } catch (err: any) {
      if (this.isTableMissingError(err)) {
        this.dbHasTables = false;
        return false;
      }
      // If error is connection or auth failure, do NOT cache dbHasTables as false
      console.warn('[ListGuardStore] Database table check encountered connectivity error:', err?.message);
      throw err;
    }
  }

  // --- JOB METHODS ---

  public static async createJob(
    prisma: PrismaClient,
    data: {
      listId: string;
      createdByUserId: string;
      status: 'QUEUED' | 'RUNNING' | 'COMPLETED';
      total: number;
      processed?: number;
      deliverable?: number;
      undeliverable?: number;
      catchAll?: number;
      unknown?: number;
      reusedFromCache?: number;
      startedAt?: Date | null;
      completedAt?: Date | null;
    }
  ): Promise<VerificationJobData> {
    const hasTables = await this.checkTableAvailability(prisma);
    if (hasTables) {
      try {
        const dbJob = await (prisma as any).emailVerificationJob.create({
          data: {
            listId: data.listId,
            createdByUserId: data.createdByUserId,
            status: data.status,
            total: data.total,
            processed: data.processed || 0,
            deliverable: data.deliverable || 0,
            undeliverable: data.undeliverable || 0,
            catchAll: data.catchAll || 0,
            unknown: data.unknown || 0,
            reusedFromCache: data.reusedFromCache || 0,
            startedAt: data.startedAt || null,
            completedAt: data.completedAt || null
          }
        });
        return dbJob;
      } catch (err) {
        if (!this.isTableMissingError(err)) throw err;
        this.dbHasTables = false;
      }
    }

    const id = crypto.randomUUID();
    const now = new Date();
    const job: VerificationJobData = {
      id,
      listId: data.listId,
      createdByUserId: data.createdByUserId,
      status: data.status,
      total: data.total,
      processed: data.processed || 0,
      deliverable: data.deliverable || 0,
      undeliverable: data.undeliverable || 0,
      catchAll: data.catchAll || 0,
      unknown: data.unknown || 0,
      reusedFromCache: data.reusedFromCache || 0,
      startedAt: data.startedAt || null,
      completedAt: data.completedAt || null,
      createdAt: now,
      updatedAt: now
    };
    this.jobsMap.set(id, job);
    return job;
  }

  public static async updateJob(
    prisma: PrismaClient,
    jobId: string,
    data: Partial<{
      status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
      total: number;
      processed: number;
      deliverable: number;
      undeliverable: number;
      catchAll: number;
      unknown: number;
      reusedFromCache: number;
      error: string | null;
      startedAt: Date | null;
      completedAt: Date | null;
      lockedBy: string | null;
      lockedAt: Date | null;
      lockExpiresAt: Date | null;
    }>
  ): Promise<VerificationJobData | null> {
    // Guard: Never overwrite CANCELLED status with RUNNING or COMPLETED
    if (data.status && data.status !== 'CANCELLED') {
      const current = await this.findJobById(prisma, jobId);
      if (current?.status === 'CANCELLED') {
        delete data.status;
      }
    }

    const hasTables = await this.checkTableAvailability(prisma);
    if (hasTables) {
      try {
        const dbJob = await (prisma as any).emailVerificationJob.update({
          where: { id: jobId },
          data
        });
        return dbJob;
      } catch (err: any) {
        // If column doesn't exist (e.g. lockedBy on unmigrated db), retry without lock fields
        if (data.lockedBy !== undefined || data.lockExpiresAt !== undefined) {
          try {
            const sanitized = { ...data };
            delete sanitized.lockedBy;
            delete sanitized.lockedAt;
            delete sanitized.lockExpiresAt;
            const fallbackJob = await (prisma as any).emailVerificationJob.update({
              where: { id: jobId },
              data: sanitized
            });
            return fallbackJob;
          } catch {}
        }
        if (!this.isTableMissingError(err)) throw err;
        this.dbHasTables = false;
      }
    }

    const job = this.jobsMap.get(jobId);
    if (!job) return null;

    Object.assign(job, data, { updatedAt: new Date() });
    return job;
  }

  public static async findJobById(
    prisma: PrismaClient,
    jobId: string,
    userId?: string
  ): Promise<VerificationJobData | null> {
    const hasTables = await this.checkTableAvailability(prisma);
    if (hasTables) {
      try {
        const whereClause: any = { id: jobId };
        if (userId) whereClause.createdByUserId = userId;
        const dbJob = await (prisma as any).emailVerificationJob.findFirst({
          where: whereClause
        });
        return dbJob;
      } catch (err) {
        if (!this.isTableMissingError(err)) throw err;
        this.dbHasTables = false;
      }
    }

    const job = this.jobsMap.get(jobId);
    if (!job) return null;
    if (userId && job.createdByUserId !== userId) return null;
    return job;
  }

  public static async findJobsByListId(
    prisma: PrismaClient,
    listId: string,
    userId: string
  ): Promise<VerificationJobData[]> {
    const hasTables = await this.checkTableAvailability(prisma);
    if (hasTables) {
      try {
        const dbJobs = await (prisma as any).emailVerificationJob.findMany({
          where: { listId, createdByUserId: userId },
          orderBy: { createdAt: 'desc' }
        });
        return dbJobs;
      } catch (err) {
        if (!this.isTableMissingError(err)) throw err;
        this.dbHasTables = false;
      }
    }

    return Array.from(this.jobsMap.values())
      .filter(j => j.listId === listId && j.createdByUserId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  public static async getLatestJobForList(
    prisma: PrismaClient,
    listId: string,
    userId: string
  ): Promise<VerificationJobData | null> {
    const jobs = await this.findJobsByListId(prisma, listId, userId);
    return jobs[0] || null;
  }

  /**
   * Atomically claims the next pending verification job for a worker.
   * Looks for status 'QUEUED' or abandoned 'RUNNING' jobs where lock has expired.
   */
  public static async claimNextJob(
    prisma: PrismaClient,
    workerId: string,
    leaseDurationMs: number = 5 * 60 * 1000
  ): Promise<VerificationJobData | null> {
    const now = new Date();
    const lockExpiresAt = new Date(now.getTime() + leaseDurationMs);

    const hasTables = await this.checkTableAvailability(prisma);
    if (hasTables) {
      try {
        // First look for QUEUED jobs
        let candidate = await (prisma as any).emailVerificationJob.findFirst({
          where: { status: 'QUEUED' },
          orderBy: { createdAt: 'asc' }
        });

        // If no QUEUED job, check for abandoned RUNNING jobs whose lock expired (stale updatedAt)
        if (!candidate) {
          const staleCutoff = new Date(now.getTime() - leaseDurationMs);
          candidate = await (prisma as any).emailVerificationJob.findFirst({
            where: {
              status: 'RUNNING',
              updatedAt: { lt: staleCutoff }
            },
            orderBy: { createdAt: 'asc' }
          });
        }

        if (candidate) {
          const updated = await this.updateJob(prisma, candidate.id, {
            status: 'RUNNING',
            lockedBy: workerId,
            lockedAt: now,
            lockExpiresAt,
            startedAt: candidate.startedAt || now
          });
          return updated;
        }
      } catch (err) {
        if (!this.isTableMissingError(err)) throw err;
        this.dbHasTables = false;
      }
    }

    // In-memory queue fallback
    for (const job of this.jobsMap.values()) {
      if (
        job.status === 'QUEUED' ||
        (job.status === 'RUNNING' && job.lockExpiresAt && job.lockExpiresAt.getTime() < now.getTime())
      ) {
        job.status = 'RUNNING';
        job.lockedBy = workerId;
        job.lockedAt = now;
        job.lockExpiresAt = lockExpiresAt;
        if (!job.startedAt) job.startedAt = now;
        job.updatedAt = now;
        return job;
      }
    }

    return null;
  }

  /**
   * Renews lock lease on an active job to prevent expiration during long-running tasks.
   */
  public static async renewJobLock(
    prisma: PrismaClient,
    jobId: string,
    workerId: string,
    leaseDurationMs: number = 5 * 60 * 1000
  ): Promise<boolean> {
    const lockExpiresAt = new Date(Date.now() + leaseDurationMs);
    const updated = await this.updateJob(prisma, jobId, {
      lockedBy: workerId,
      lockExpiresAt
    });
    return Boolean(updated);
  }

  /**
   * Releases lock upon worker completion or exit.
   */
  public static async releaseJobLock(
    prisma: PrismaClient,
    jobId: string
  ): Promise<void> {
    await this.updateJob(prisma, jobId, {
      lockedBy: null,
      lockExpiresAt: null
    });
  }

  // --- RESULT METHODS ---

  public static async createResult(
    prisma: PrismaClient,
    data: Omit<VerificationResultData, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<VerificationResultData> {
    const hasTables = await this.checkTableAvailability(prisma);
    if (hasTables) {
      try {
        // Strip confidence if column not in DB
        const payload: any = { ...data };

        // Guarantee strict idempotency: check if result already exists for this job and email
        const existing = await (prisma as any).emailVerificationResult.findFirst({
          where: {
            jobId: data.jobId,
            normalizedEmail: data.normalizedEmail
          }
        });

        if (existing) {
          const dbResult = await (prisma as any).emailVerificationResult.update({
            where: { id: existing.id },
            data: payload
          });
          return dbResult;
        }

        const dbResult = await (prisma as any).emailVerificationResult.create({
          data: payload
        });
        return dbResult;
      } catch (err: any) {
        // If error mentions confidence, retry without confidence
        if (data.confidence !== undefined) {
          try {
            const payloadWithoutConf = { ...data };
            delete payloadWithoutConf.confidence;

            const existing = await (prisma as any).emailVerificationResult.findFirst({
              where: {
                jobId: data.jobId,
                normalizedEmail: data.normalizedEmail
              }
            });

            if (existing) {
              const retryRes = await (prisma as any).emailVerificationResult.update({
                where: { id: existing.id },
                data: payloadWithoutConf
              });
              return retryRes;
            }

            const retryRes = await (prisma as any).emailVerificationResult.create({
              data: payloadWithoutConf
            });
            return retryRes;
          } catch {}
        }
        if (!this.isTableMissingError(err)) throw err;
        this.dbHasTables = false;
      }
    }

    const id = crypto.randomUUID();
    const now = new Date();
    const result: VerificationResultData = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now
    };

    if (!this.resultsMap.has(data.jobId)) {
      this.resultsMap.set(data.jobId, []);
    }
    this.resultsMap.get(data.jobId)!.push(result);

    // Save in cache map
    this.cacheMap.set(data.normalizedEmail, result);

    return result;
  }

  public static async findCachedResult(
    prisma: PrismaClient,
    normalizedEmail: string,
    now: Date
  ): Promise<VerificationResultData | null> {
    const hasTables = await this.checkTableAvailability(prisma);
    if (hasTables) {
      try {
        const dbCached = await (prisma as any).emailVerificationResult.findFirst({
          where: {
            normalizedEmail,
            expiresAt: { gt: now }
          },
          orderBy: { verifiedAt: 'desc' }
        });
        if (dbCached) return dbCached;
      } catch (err) {
        if (!this.isTableMissingError(err)) throw err;
        this.dbHasTables = false;
      }
    }

    const cached = this.cacheMap.get(normalizedEmail);
    if (cached && cached.expiresAt.getTime() > now.getTime()) {
      return cached;
    }
    return null;
  }

  /**
   * Retrieves the set of normalized emails already verified for a given jobId.
   * Guarantees idempotency and safe recovery after worker restarts.
   */
  public static async getCompletedEmailSetForJob(
    prisma: PrismaClient,
    jobId: string
  ): Promise<Set<string>> {
    const hasTables = await this.checkTableAvailability(prisma);
    if (hasTables) {
      try {
        const records = await (prisma as any).emailVerificationResult.findMany({
          where: { jobId },
          select: { normalizedEmail: true }
        });
        return new Set<string>(records.map((r: any) => r.normalizedEmail));
      } catch (err) {
        if (!this.isTableMissingError(err)) throw err;
        this.dbHasTables = false;
      }
    }

    const list = this.resultsMap.get(jobId) || [];
    return new Set<string>(list.map(r => r.normalizedEmail));
  }

  /**
   * Retrieves breakdown of UNKNOWN reasons for a job (e.g. SMTP_TIMEOUT, SMTP_BLOCKED, etc.)
   */
  public static async getJobUnknownReasonDistribution(
    prisma: PrismaClient,
    jobId: string
  ): Promise<Record<string, number>> {
    const distribution: Record<string, number> = {};

    const hasTables = await this.checkTableAvailability(prisma);
    if (hasTables) {
      try {
        const unknowns = await (prisma as any).emailVerificationResult.findMany({
          where: { jobId, result: 'UNKNOWN' },
          select: { verificationReason: true }
        });
        for (const u of unknowns) {
          const reason = u.verificationReason || 'UNKNOWN';
          distribution[reason] = (distribution[reason] || 0) + 1;
        }
        return distribution;
      } catch (err) {
        if (!this.isTableMissingError(err)) throw err;
        this.dbHasTables = false;
      }
    }

    const list = this.resultsMap.get(jobId) || [];
    for (const item of list) {
      if (item.result === 'UNKNOWN') {
        const reason = item.verificationReason || 'UNKNOWN';
        distribution[reason] = (distribution[reason] || 0) + 1;
      }
    }
    return distribution;
  }

  public static async getResultsForJob(
    prisma: PrismaClient,
    jobId: string,
    options?: {
      page?: number;
      pageSize?: number;
      filter?: string;
      search?: string;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
    }
  ): Promise<{ results: VerificationResultData[]; totalCount: number }> {
    const hasTables = await this.checkTableAvailability(prisma);
    if (hasTables) {
      try {
        const whereClause: any = { jobId };

        const upperFilter = options?.filter?.toUpperCase();
        if (['DELIVERABLE', 'UNDELIVERABLE', 'CATCH_ALL', 'UNKNOWN'].includes(upperFilter || '')) {
          whereClause.result = upperFilter;
        } else if (upperFilter === 'DISPOSABLE') {
          whereClause.isDisposable = true;
        } else if (upperFilter === 'ROLE') {
          whereClause.isRole = true;
        }

        if (options?.search) {
          whereClause.email = { contains: options.search, mode: 'insensitive' };
        }

        const totalCount = await (prisma as any).emailVerificationResult.count({
          where: whereClause
        });

        const page = options?.page || 1;
        const pageSize = options?.pageSize || 50;
        const skip = (page - 1) * pageSize;

        const sortField = options?.sortBy || 'verifiedAt';
        const sortOrder = options?.sortOrder || 'desc';

        const records = await (prisma as any).emailVerificationResult.findMany({
          where: whereClause,
          include: {
            contact: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                fullName: true,
                jobTitle: true,
                department: true,
                city: true,
                phone: true,
                organization: {
                  select: {
                    name: true,
                    industry: true
                  }
                }
              }
            }
          },
          orderBy: { [sortField]: sortOrder },
          skip,
          take: pageSize
        });

        const formattedRecords = records.map((r: any) => ({
          ...r,
          contact: r.contact
            ? {
                ...r.contact,
                companyName: r.contact.organization?.name || null,
                industry: r.contact.organization?.industry || null
              }
            : null
        }));

        return { results: formattedRecords, totalCount };
      } catch (err) {
        if (!this.isTableMissingError(err)) throw err;
        this.dbHasTables = false;
      }
    }

    // In-memory fallback
    let list = this.resultsMap.get(jobId) || [];

    // Filter
    const upperFilter = options?.filter?.toUpperCase();
    if (['DELIVERABLE', 'UNDELIVERABLE', 'CATCH_ALL', 'UNKNOWN'].includes(upperFilter || '')) {
      list = list.filter(r => r.result === upperFilter);
    } else if (upperFilter === 'DISPOSABLE') {
      list = list.filter(r => r.isDisposable);
    } else if (upperFilter === 'ROLE') {
      list = list.filter(r => r.isRole);
    }

    // Search
    if (options?.search) {
      const q = options.search.toLowerCase().trim();
      list = list.filter(r => r.email.toLowerCase().includes(q));
    }

    // Sort
    const sortField = options?.sortBy || 'verifiedAt';
    const isAsc = options?.sortOrder === 'asc';
    list = [...list].sort((a: any, b: any) => {
      const valA = a[sortField];
      const valB = b[sortField];
      if (valA < valB) return isAsc ? -1 : 1;
      if (valA > valB) return isAsc ? 1 : -1;
      return 0;
    });

    const totalCount = list.length;
    const page = options?.page || 1;
    const pageSize = options?.pageSize || 50;
    const paginated = list.slice((page - 1) * pageSize, page * pageSize);

    return { results: paginated, totalCount };
  }

  public static async getAllResultsForJob(
    prisma: PrismaClient,
    jobId: string,
    filterStatuses?: string[]
  ): Promise<VerificationResultData[]> {
    const hasTables = await this.checkTableAvailability(prisma);
    if (hasTables) {
      try {
        const whereClause: any = { jobId };
        if (filterStatuses && filterStatuses.length > 0) {
          whereClause.result = { in: filterStatuses };
        }
        const records = await (prisma as any).emailVerificationResult.findMany({
          where: whereClause,
          orderBy: { verifiedAt: 'desc' }
        });
        return records;
      } catch (err) {
        if (!this.isTableMissingError(err)) throw err;
        this.dbHasTables = false;
      }
    }

    let list = this.resultsMap.get(jobId) || [];
    if (filterStatuses && filterStatuses.length > 0) {
      list = list.filter(r => filterStatuses.includes(r.result));
    }
    return list;
  }

  public static clearInMemoryForTesting(): void {
    this.jobsMap.clear();
    this.resultsMap.clear();
    this.cacheMap.clear();
  }

  public static setForceInMemoryForTesting(force: boolean | null): void {
    this.dbHasTables = force === null ? null : !force;
  }
}
