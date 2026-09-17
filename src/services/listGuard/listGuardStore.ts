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
    } catch (err) {
      if (this.isTableMissingError(err)) {
        this.dbHasTables = false;
      } else {
        this.dbHasTables = false;
      }
    }
    return this.dbHasTables;
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

    // In-memory fallback
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
    data: Partial<VerificationJobData>
  ): Promise<void> {
    const hasTables = await this.checkTableAvailability(prisma);
    if (hasTables) {
      try {
        await (prisma as any).emailVerificationJob.update({
          where: { id: jobId },
          data
        });
        return;
      } catch (err) {
        if (!this.isTableMissingError(err)) throw err;
        this.dbHasTables = false;
      }
    }

    const job = this.jobsMap.get(jobId);
    if (job) {
      Object.assign(job, data, { updatedAt: new Date() });
    }
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
        if (dbJob) return dbJob;
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

  // --- RESULT METHODS ---

  public static async createResult(
    prisma: PrismaClient,
    data: Omit<VerificationResultData, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<VerificationResultData> {
    const hasTables = await this.checkTableAvailability(prisma);
    if (hasTables) {
      try {
        const dbResult = await (prisma as any).emailVerificationResult.create({
          data
        });
        return dbResult;
      } catch (err) {
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

  public static async getResultsForJob(
    prisma: PrismaClient,
    jobId: string,
    options?: {
      filter?: string;
      search?: string;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      page?: number;
      pageSize?: number;
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
          const q = options.search.trim();
          whereClause.email = { contains: q, mode: 'insensitive' };
        }

        const page = options?.page || 1;
        const pageSize = options?.pageSize || 50;
        const skip = (page - 1) * pageSize;

        const totalCount = await (prisma as any).emailVerificationResult.count({
          where: whereClause
        });
        const results = await (prisma as any).emailVerificationResult.findMany({
          where: whereClause,
          skip,
          take: pageSize,
          orderBy: { [options?.sortBy || 'verifiedAt']: options?.sortOrder || 'desc' }
        });
        return { results, totalCount };
      } catch (err) {
        if (!this.isTableMissingError(err)) throw err;
        this.dbHasTables = false;
      }
    }

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
}
