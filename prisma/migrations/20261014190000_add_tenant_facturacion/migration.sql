-- CreateEnum
CREATE TYPE "EstadoCobro" AS ENUM ('AL_CORRIENTE', 'VENCIDO');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "plan" TEXT;
ALTER TABLE "tenants" ADD COLUMN "montoMensual" DOUBLE PRECISION;
ALTER TABLE "tenants" ADD COLUMN "proximoCobro" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN "estadoCobro" "EstadoCobro" NOT NULL DEFAULT 'AL_CORRIENTE';
