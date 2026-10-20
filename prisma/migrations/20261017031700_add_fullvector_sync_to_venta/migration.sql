-- CreateEnum
CREATE TYPE "FullvectorSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED');

-- AlterTable
ALTER TABLE "ventas" ADD COLUMN     "fullvectorSyncStatus" "FullvectorSyncStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "fullvectorOrderId" TEXT,
ADD COLUMN     "fullvectorError" TEXT,
ADD COLUMN     "fullvectorAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fullvectorSyncedAt" TIMESTAMP(3);
