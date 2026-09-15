-- AlterEnum
ALTER TYPE "LeadStatus" ADD VALUE 'REAGENDADO';

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "fechaReagenda" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "lead_items" (
    "id" SERIAL NOT NULL,
    "leadId" INTEGER NOT NULL,
    "productoId" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL DEFAULT 1,
    "precioUnitario" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" INTEGER NOT NULL,

    CONSTRAINT "lead_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_items_leadId_idx" ON "lead_items"("leadId");

-- AddForeignKey
ALTER TABLE "lead_items" ADD CONSTRAINT "lead_items_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_items" ADD CONSTRAINT "lead_items_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_items" ADD CONSTRAINT "lead_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
