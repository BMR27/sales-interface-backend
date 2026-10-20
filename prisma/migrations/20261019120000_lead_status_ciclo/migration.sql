-- El ciclo de un lead queda en cuatro estatus: NUEVO (nuevo ingreso),
-- REAGENDADO (re-llamar), DESCARTADO y VENTA (concretado).
--
-- SEGUIMIENTO y NEGOCIACION desaparecen: eran estados intermedios que la
-- vendedora nunca elegía a mano (NEGOCIACION lo ponía el confirmar de la
-- llamada), así que los leads que estén ahí regresan a NUEVO -- siguen
-- pendientes de cerrar. ARCHIVADO se renombra a DESCARTADO, que es lo que
-- siempre significó.

UPDATE "leads" SET "status" = 'NUEVO' WHERE "status" IN ('SEGUIMIENTO', 'NEGOCIACION');

ALTER TYPE "LeadStatus" RENAME VALUE 'ARCHIVADO' TO 'DESCARTADO';

-- Postgres no permite quitar valores de un enum: hay que recrear el tipo.
ALTER TYPE "LeadStatus" RENAME TO "LeadStatus_old";
CREATE TYPE "LeadStatus" AS ENUM ('NUEVO', 'REAGENDADO', 'DESCARTADO', 'VENTA');
ALTER TABLE "leads" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "leads" ALTER COLUMN "status" TYPE "LeadStatus" USING ("status"::text::"LeadStatus");
ALTER TABLE "leads" ALTER COLUMN "status" SET DEFAULT 'NUEVO';
DROP TYPE "LeadStatus_old";
