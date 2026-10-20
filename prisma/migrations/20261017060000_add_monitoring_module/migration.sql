-- CreateTable
CREATE TABLE "error_logs" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT,
    "path" TEXT,
    "statusCode" INTEGER,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "userId" INTEGER,
    "tenantId" INTEGER,

    CONSTRAINT "error_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "error_logs_createdAt_idx" ON "error_logs"("createdAt");

-- CreateTable
CREATE TABLE "request_metrics" (
    "id" SERIAL NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "route" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "totalDurationMs" INTEGER NOT NULL DEFAULT 0,
    "maxDurationMs" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "request_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "request_metrics_windowStart_idx" ON "request_metrics"("windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "request_metrics_windowStart_route_method_key" ON "request_metrics"("windowStart", "route", "method");

-- CreateTable
CREATE TABLE "memory_snapshots" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rssMb" DOUBLE PRECISION NOT NULL,
    "heapUsedMb" DOUBLE PRECISION NOT NULL,
    "heapTotalMb" DOUBLE PRECISION NOT NULL,
    "freeMemMb" DOUBLE PRECISION NOT NULL,
    "loadAvg1" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "memory_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_snapshots_createdAt_idx" ON "memory_snapshots"("createdAt");
