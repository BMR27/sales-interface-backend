const os = require("node:os");
const { drainBuckets } = require("../lib/requestMetrics");

const prisma = require("../lib/prisma");

const MEMORY_INTERVAL_MS = 60 * 1000;
const FLUSH_INTERVAL_TICKS = 5; // cada 5 ticks de 1 min = cada 5 min
const PRUNE_INTERVAL_TICKS = 60; // cada 60 ticks de 1 min = cada hora
const RETENTION_DAYS = 14;

const BUCKET_MS = 5 * 60 * 1000;

function bucketStart(date) {
  return new Date(Math.floor(date.getTime() / BUCKET_MS) * BUCKET_MS);
}

async function sampleMemory() {
  const mem = process.memoryUsage();
  const toMb = (bytes) => Math.round((bytes / 1024 / 1024) * 100) / 100;
  await prisma.memorySnapshot.create({
    data: {
      rssMb: toMb(mem.rss),
      heapUsedMb: toMb(mem.heapUsed),
      heapTotalMb: toMb(mem.heapTotal),
      freeMemMb: toMb(os.freemem()),
      loadAvg1: Math.round(os.loadavg()[0] * 100) / 100,
    },
  });
}

async function flushRequestMetrics() {
  const drained = drainBuckets();
  if (drained.length === 0) return;
  const windowStart = bucketStart(new Date());

  // Normalmente un solo flush cae por bucket de 5 min (el job vacía justo
  // cada 5 min), así que esto casi siempre inserta. El UPSERT con
  // GREATEST cubre el caso raro de un flush extra (ej. reinicio del
  // proceso a mitad de bucket) sin perder el máximo ya guardado.
  for (const entry of drained) {
    await prisma.$executeRaw`
      INSERT INTO "request_metrics" ("windowStart", "route", "method", "count", "totalDurationMs", "maxDurationMs", "errorCount")
      VALUES (${windowStart}, ${entry.route}, ${entry.method}, ${entry.count}, ${entry.totalDurationMs}, ${entry.maxDurationMs}, ${entry.errorCount})
      ON CONFLICT ("windowStart", "route", "method") DO UPDATE SET
        "count" = "request_metrics"."count" + EXCLUDED."count",
        "totalDurationMs" = "request_metrics"."totalDurationMs" + EXCLUDED."totalDurationMs",
        "maxDurationMs" = GREATEST("request_metrics"."maxDurationMs", EXCLUDED."maxDurationMs"),
        "errorCount" = "request_metrics"."errorCount" + EXCLUDED."errorCount"
    `.catch((err) => console.error("monitoring: flush request metric error", err));
  }
}

async function pruneOldData() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await Promise.all([
    prisma.errorLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.requestMetric.deleteMany({ where: { windowStart: { lt: cutoff } } }),
    prisma.memorySnapshot.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]).catch((err) => console.error("monitoring: prune error", err));
}

function startMonitoringJob() {
  let tick = 0;
  setInterval(async () => {
    tick += 1;
    await sampleMemory().catch((err) => console.error("monitoring: memory sample error", err));
    if (tick % FLUSH_INTERVAL_TICKS === 0) await flushRequestMetrics();
    if (tick % PRUNE_INTERVAL_TICKS === 0) await pruneOldData();
  }, MEMORY_INTERVAL_MS);
}

module.exports = { startMonitoringJob };
