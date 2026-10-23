-- AlterTable
ALTER TABLE "ventas" ADD COLUMN     "entregaConfirmadaAt" TIMESTAMP(3),
ADD COLUMN     "entregaConfirmadaPor" TEXT,
ADD COLUMN     "cancelada" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canceladaAt" TIMESTAMP(3),
ADD COLUMN     "canceladaMotivo" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "asignadoPorId" INTEGER;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_asignadoPorId_fkey" FOREIGN KEY ("asignadoPorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Las ventas existentes nacieron con entregaExitosa=true porque el frontend
-- lo mandaba asi al cerrar la venta, no porque alguien confirmara la entrega.
-- Se dejan en true para no borrar historia, pero se marca la fecha de
-- confirmacion como nula: no hubo tal confirmacion.
UPDATE "ventas" SET "entregaConfirmadaAt" = NULL WHERE "entregaExitosa" = true;
