-- CreateEnum
CREATE TYPE "PrepagoEstado" AS ENUM ('PENDIENTE_CONTACTO', 'TRANSFERENCIA_OFRECIDA', 'PAGO_CONFIRMADO', 'ENVIADO', 'CANCELADO');

-- CreateTable
CREATE TABLE "prepago_gestiones" (
    "id" SERIAL NOT NULL,
    "ventaId" INTEGER NOT NULL,
    "estado" "PrepagoEstado" NOT NULL DEFAULT 'PENDIENTE_CONTACTO',
    "pagoReferencia" TEXT,
    "pagoMonto" DOUBLE PRECISION,
    "pagoConfirmadoAt" TIMESTAMP(3),
    "pagoConfirmadoPor" TEXT,
    "paqueteria" TEXT,
    "guia" TEXT,
    "enviadoAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" INTEGER NOT NULL,

    CONSTRAINT "prepago_gestiones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prepago_notas" (
    "id" SERIAL NOT NULL,
    "gestionId" INTEGER NOT NULL,
    "nota" TEXT NOT NULL,
    "autorId" INTEGER,
    "autorNombre" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" INTEGER NOT NULL,

    CONSTRAINT "prepago_notas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prepago_gestiones_ventaId_key" ON "prepago_gestiones"("ventaId");

-- CreateIndex
CREATE INDEX "prepago_gestiones_tenantId_estado_idx" ON "prepago_gestiones"("tenantId", "estado");

-- CreateIndex
CREATE INDEX "prepago_notas_gestionId_idx" ON "prepago_notas"("gestionId");

-- AddForeignKey
ALTER TABLE "prepago_gestiones" ADD CONSTRAINT "prepago_gestiones_ventaId_fkey" FOREIGN KEY ("ventaId") REFERENCES "ventas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prepago_gestiones" ADD CONSTRAINT "prepago_gestiones_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prepago_notas" ADD CONSTRAINT "prepago_notas_gestionId_fkey" FOREIGN KEY ("gestionId") REFERENCES "prepago_gestiones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prepago_notas" ADD CONSTRAINT "prepago_notas_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
