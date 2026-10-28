-- Fecha en que el lead paso a su vendedora actual. Sin esto el reporte de
-- Progreso solo podia mirar createdAt y los leads reasignados de otros dias
-- no aparecian en el corte del dia en que se repartieron.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "asignadoAt" TIMESTAMP(3);

-- Los leads que ya tenian dueña antes de esta columna se dan por asignados
-- el dia que entraron: es la mejor aproximacion disponible y deja el
-- historico consistente con lo que el reporte ya mostraba.
UPDATE "leads" SET "asignadoAt" = "createdAt"
WHERE "vendedorId" IS NOT NULL AND "asignadoAt" IS NULL;

-- El reporte de Progreso corta por esta fecha en cada carga.
CREATE INDEX IF NOT EXISTS "leads_asignadoAt_idx" ON "leads"("asignadoAt");
