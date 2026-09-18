import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

export type WorkerStatus = 'ONLINE' | 'BUSY' | 'DRAINING' | 'OFFLINE';

export interface WorkerHeartbeatData {
  workerId: string;
  version: string;
  status: WorkerStatus;
  hostname?: string;
  startedAt: Date;
  lastHeartbeatAt: Date;
  activeJobs: number;
  processedCount: number;
  currentJobId: string | null;
  metadata?: any;
}

export class WorkerHealthService {
  private static memoryHeartbeats: Map<string, WorkerHeartbeatData> = new Map();
  private static dbHasHeartbeatTable: boolean | null = null;
  private static readonly heartbeatFilePath = path.join(process.cwd(), '.worker_heartbeat.json');

  /**
   * Ensures the ListGuardWorker table exists in PostgreSQL.
   */
  public static async ensureTable(prisma: PrismaClient): Promise<void> {
    if (this.dbHasHeartbeatTable === true) return;
    try {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "ListGuardWorker" (
          "id" TEXT PRIMARY KEY,
          "workerId" TEXT UNIQUE NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'ONLINE',
          "version" TEXT NOT NULL DEFAULT '1.0.0',
          "hostname" TEXT,
          "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "currentJobId" TEXT,
          "activeJobs" INTEGER NOT NULL DEFAULT 0,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "ListGuardWorker_status_lastHeartbeatAt_idx" ON "ListGuardWorker"("status", "lastHeartbeatAt");
      `);
      this.dbHasHeartbeatTable = true;
    } catch (err: any) {
      console.warn('[WorkerHealthService] Table check error:', err?.message);
    }
  }

  /**
   * Records or updates a worker heartbeat into PostgreSQL.
   */
  public static async registerHeartbeat(
    prisma: PrismaClient,
    data: WorkerHeartbeatData
  ): Promise<void> {
    // 1. Keep memory map updated
    this.memoryHeartbeats.set(data.workerId, { ...data });

    // 2. Local development fallback (filesystem)
    if (process.env.NODE_ENV !== 'production') {
      try {
        fs.writeFileSync(this.heartbeatFilePath, JSON.stringify(data), 'utf8');
      } catch {}
    }

    // 3. PostgreSQL persistence (Production Source of Truth)
    try {
      await this.ensureTable(prisma);
      const id = (data as any).id || crypto.randomUUID();
      const hostname = data.hostname || null;
      const currentJobId = data.currentJobId || null;

      await prisma.$executeRawUnsafe(`
        INSERT INTO "ListGuardWorker" (
          "id", "workerId", "status", "version", "hostname", 
          "lastHeartbeatAt", "startedAt", "currentJobId", "activeJobs", 
          "createdAt", "updatedAt"
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW()
        )
        ON CONFLICT ("workerId") DO UPDATE SET
          "status" = EXCLUDED."status",
          "version" = EXCLUDED."version",
          "hostname" = COALESCE(EXCLUDED."hostname", "ListGuardWorker"."hostname"),
          "lastHeartbeatAt" = EXCLUDED."lastHeartbeatAt",
          "currentJobId" = EXCLUDED."currentJobId",
          "activeJobs" = EXCLUDED."activeJobs",
          "updatedAt" = NOW();
      `,
        id,
        data.workerId,
        data.status,
        data.version,
        hostname,
        data.lastHeartbeatAt,
        data.startedAt,
        currentJobId,
        data.activeJobs
      );
      this.dbHasHeartbeatTable = true;
    } catch (err: any) {
      console.error('[WorkerHealthService] Failed to persist worker heartbeat to PostgreSQL:', err?.message);
    }
  }

  /**
   * Retrieves overall worker system availability from PostgreSQL.
   * A worker is considered available if it has reported a heartbeat within the last 45 seconds.
   */
  public static async getWorkerHealthStatus(
    prisma: PrismaClient,
    heartbeatWindowMs: number = 75000
  ): Promise<{
    available: boolean;
    status: 'ONLINE' | 'BUSY' | 'UNAVAILABLE';
    activeWorkerCount: number;
    workers: Array<{
      workerId: string;
      version: string;
      status: WorkerStatus;
      hostname?: string | null;
      lastHeartbeatAt: Date;
      startedAt?: Date;
      activeJobs: number;
      processedCount?: number;
      currentJobId: string | null;
    }>;
  }> {
    const cutoff = new Date(Date.now() - heartbeatWindowMs);
    let activeWorkers: any[] = [];
    let postgresSuccess = false;

    // 1. Query PostgreSQL first (Production Source of Truth)
    try {
      await this.ensureTable(prisma);
      const rows: any = await prisma.$queryRawUnsafe(`
        SELECT "id", "workerId", "status", "version", "hostname", 
               "lastHeartbeatAt", "startedAt", "currentJobId", "activeJobs", 
               "createdAt", "updatedAt"
        FROM "ListGuardWorker"
        WHERE "lastHeartbeatAt" > $1::timestamp AND "status" != 'OFFLINE'
        ORDER BY "lastHeartbeatAt" DESC;
      `, cutoff.toISOString());

      postgresSuccess = true;

      if (Array.isArray(rows) && rows.length > 0) {
        activeWorkers = rows.map((r: any) => ({
          workerId: r.workerId,
          version: r.version,
          status: r.status as WorkerStatus,
          hostname: r.hostname,
          lastHeartbeatAt: new Date(r.lastHeartbeatAt),
          startedAt: new Date(r.startedAt),
          activeJobs: Number(r.activeJobs || 0),
          currentJobId: r.currentJobId || null,
          processedCount: 0
        }));
      }
    } catch (err: any) {
      console.warn('[WorkerHealthService] PostgreSQL worker query failed:', err?.message);
      postgresSuccess = false;
    }

    // 2. Production Source of Truth Rule:
    // If PostgreSQL query was attempted and succeeded, activeWorkers comes exclusively from PostgreSQL.
    // If PostgreSQL query failed (e.g. pool timeout or connection dropped), we DO NOT falsely report
    // worker as ONLINE from disk if the database is unreachable, because a worker cannot claim jobs
    // without a healthy PostgreSQL connection.
    if (!postgresSuccess) {
      console.warn('[WorkerHealthService] PostgreSQL worker query failed. Reporting UNAVAILABLE.');
    }

    const available = activeWorkers.length > 0;
    const isBusy = activeWorkers.some(w => w.status === 'BUSY' || w.activeJobs > 0);

    return {
      available,
      status: available ? (isBusy ? 'BUSY' : 'ONLINE') : 'UNAVAILABLE',
      activeWorkerCount: activeWorkers.length,
      workers: activeWorkers.map(w => ({
        workerId: w.workerId,
        version: w.version,
        status: w.status,
        hostname: w.hostname,
        lastHeartbeatAt: w.lastHeartbeatAt,
        startedAt: w.startedAt,
        activeJobs: w.activeJobs,
        processedCount: w.processedCount || 0,
        currentJobId: w.currentJobId
      }))
    };
  }

  /**
   * Marks a worker OFFLINE in PostgreSQL upon graceful shutdown.
   */
  public static async markWorkerOffline(
    prisma: PrismaClient,
    workerId: string
  ): Promise<void> {
    const mem = this.memoryHeartbeats.get(workerId);
    if (mem) {
      mem.status = 'OFFLINE';
      mem.lastHeartbeatAt = new Date();
    }

    if (process.env.NODE_ENV !== 'production') {
      try {
        if (fs.existsSync(this.heartbeatFilePath)) {
          const raw = fs.readFileSync(this.heartbeatFilePath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed.workerId === workerId) {
            parsed.status = 'OFFLINE';
            parsed.lastHeartbeatAt = new Date();
            fs.writeFileSync(this.heartbeatFilePath, JSON.stringify(parsed), 'utf8');
          }
        }
      } catch {}
    }

    try {
      await this.ensureTable(prisma);
      await prisma.$executeRawUnsafe(`
        UPDATE "ListGuardWorker"
        SET "status" = 'OFFLINE', "lastHeartbeatAt" = NOW(), "updatedAt" = NOW()
        WHERE "workerId" = $1;
      `, workerId);
    } catch (err: any) {
      console.warn('[WorkerHealthService] Failed to mark worker offline in PostgreSQL:', err?.message);
    }
  }
}

