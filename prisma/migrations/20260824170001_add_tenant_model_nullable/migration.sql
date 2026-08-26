-- CreateEnum
CREATE TYPE "TipoPersona" AS ENUM ('FISICA', 'MORAL');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('PENDIENTE', 'ACTIVO', 'RECHAZADO', 'SUSPENDIDO');

-- AlterEnum
ALTER TYPE "Rol" ADD VALUE 'SUPER_ADMIN';

-- DropIndex
DROP INDEX "productos_sku_key";

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "tenantId" INTEGER;

-- AlterTable
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_pkey",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD COLUMN     "tenantId" INTEGER,
ADD CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "incoming_leads" ADD COLUMN     "tenantId" INTEGER;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "tenantId" INTEGER;

-- AlterTable
ALTER TABLE "llamadas" ADD COLUMN     "tenantId" INTEGER;

-- AlterTable
ALTER TABLE "movimientos_inventario" ADD COLUMN     "tenantId" INTEGER;

-- AlterTable
ALTER TABLE "productos" ADD COLUMN     "tenantId" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "tenantId" INTEGER;

-- AlterTable
ALTER TABLE "ventas" ADD COLUMN     "tenantId" INTEGER;

-- CreateTable
CREATE TABLE "tenants" (
    "id" SERIAL NOT NULL,
    "tipoPersona" "TipoPersona" NOT NULL,
    "razonSocial" TEXT NOT NULL,
    "nombreComercial" TEXT,
    "emailContacto" TEXT NOT NULL,
    "telefono" TEXT,
    "status" "TenantStatus" NOT NULL DEFAULT 'PENDIENTE',
    "motivoRechazo" TEXT,
    "aprobadoPorId" INTEGER,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_settings_tenantId_key_key" ON "app_settings"("tenantId", "key");

-- CreateIndex
CREATE INDEX "leads_tenantId_status_idx" ON "leads"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "productos_tenantId_sku_key" ON "productos"("tenantId", "sku");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_aprobadoPorId_fkey" FOREIGN KEY ("aprobadoPorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incoming_leads" ADD CONSTRAINT "incoming_leads_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productos" ADD CONSTRAINT "productos_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos_inventario" ADD CONSTRAINT "movimientos_inventario_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llamadas" ADD CONSTRAINT "llamadas_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

