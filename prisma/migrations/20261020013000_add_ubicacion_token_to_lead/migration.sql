-- AlterTable
ALTER TABLE "leads" ADD COLUMN "ubicacionToken" TEXT,
ADD COLUMN "ubicacionSolicitadaAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "leads_ubicacionToken_key" ON "leads"("ubicacionToken");
