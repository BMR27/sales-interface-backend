-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "subdominio" TEXT;
ALTER TABLE "tenants" ADD COLUMN "dominioPersonalizado" TEXT;
ALTER TABLE "tenants" ADD COLUMN "logoUrl" TEXT;
ALTER TABLE "tenants" ADD COLUMN "colorPrimario" TEXT;
ALTER TABLE "tenants" ADD COLUMN "colorSecundario" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "tenants_subdominio_key" ON "tenants"("subdominio");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_dominioPersonalizado_key" ON "tenants"("dominioPersonalizado");
