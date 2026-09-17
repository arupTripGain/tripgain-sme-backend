-- CreateTable: EmailVerificationJob
CREATE TABLE IF NOT EXISTS "EmailVerificationJob" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "deliverable" INTEGER NOT NULL DEFAULT 0,
    "undeliverable" INTEGER NOT NULL DEFAULT 0,
    "catchAll" INTEGER NOT NULL DEFAULT 0,
    "unknown" INTEGER NOT NULL DEFAULT 0,
    "reusedFromCache" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailVerificationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable: EmailVerificationResult
CREATE TABLE IF NOT EXISTS "EmailVerificationResult" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "contactId" TEXT,
    "contactEmailId" TEXT,
    "email" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "verificationReason" TEXT,
    "syntaxStatus" TEXT NOT NULL,
    "domainStatus" TEXT NOT NULL,
    "mxStatus" TEXT NOT NULL,
    "smtpStatus" TEXT NOT NULL,
    "isCatchAll" BOOLEAN NOT NULL DEFAULT false,
    "isDisposable" BOOLEAN NOT NULL DEFAULT false,
    "isRole" BOOLEAN NOT NULL DEFAULT false,
    "suppressionStatus" TEXT,
    "bounceStatus" TEXT,
    "smtpResponseCode" TEXT,
    "smtpResponse" TEXT,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailVerificationResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EmailVerificationJob_createdByUserId_listId_idx" ON "EmailVerificationJob"("createdByUserId", "listId");
CREATE INDEX IF NOT EXISTS "EmailVerificationJob_createdByUserId_createdAt_idx" ON "EmailVerificationJob"("createdByUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "EmailVerificationJob_listId_createdAt_idx" ON "EmailVerificationJob"("listId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EmailVerificationResult_jobId_result_idx" ON "EmailVerificationResult"("jobId", "result");
CREATE INDEX IF NOT EXISTS "EmailVerificationResult_normalizedEmail_expiresAt_idx" ON "EmailVerificationResult"("normalizedEmail", "expiresAt");
CREATE INDEX IF NOT EXISTS "EmailVerificationResult_contactId_idx" ON "EmailVerificationResult"("contactId");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'EmailVerificationJob_listId_fkey'
    ) THEN
        ALTER TABLE "EmailVerificationJob" ADD CONSTRAINT "EmailVerificationJob_listId_fkey" 
        FOREIGN KEY ("listId") REFERENCES "List"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'EmailVerificationJob_createdByUserId_fkey'
    ) THEN
        ALTER TABLE "EmailVerificationJob" ADD CONSTRAINT "EmailVerificationJob_createdByUserId_fkey" 
        FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'EmailVerificationResult_jobId_fkey'
    ) THEN
        ALTER TABLE "EmailVerificationResult" ADD CONSTRAINT "EmailVerificationResult_jobId_fkey" 
        FOREIGN KEY ("jobId") REFERENCES "EmailVerificationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'EmailVerificationResult_contactId_fkey'
    ) THEN
        ALTER TABLE "EmailVerificationResult" ADD CONSTRAINT "EmailVerificationResult_contactId_fkey" 
        FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'EmailVerificationResult_contactEmailId_fkey'
    ) THEN
        ALTER TABLE "EmailVerificationResult" ADD CONSTRAINT "EmailVerificationResult_contactEmailId_fkey" 
        FOREIGN KEY ("contactEmailId") REFERENCES "ContactEmail"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
