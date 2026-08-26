-- DropForeignKey
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "incoming_leads" DROP CONSTRAINT "incoming_leads_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "leads" DROP CONSTRAINT "leads_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "llamadas" DROP CONSTRAINT "llamadas_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "movimientos_inventario" DROP CONSTRAINT "movimientos_inventario_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "productos" DROP CONSTRAINT "productos_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ventas" DROP CONSTRAINT "ventas_tenantId_fkey";

-- AlterTable
ALTER TABLE "api_keys" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "incoming_leads" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "leads" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "llamadas" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "movimientos_inventario" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "productos" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ventas" ALTER COLUMN "tenantId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incoming_leads" ADD CONSTRAINT "incoming_leads_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productos" ADD CONSTRAINT "productos_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos_inventario" ADD CONSTRAINT "movimientos_inventario_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llamadas" ADD CONSTRAINT "llamadas_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

