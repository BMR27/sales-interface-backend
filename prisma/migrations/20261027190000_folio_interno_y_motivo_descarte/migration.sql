-- Folio interno PS y motivo de descarte.

-- 1) Contador del consecutivo, uno por espacio.
CREATE TABLE IF NOT EXISTS "folio_contadores" (
  "tenantId" INTEGER NOT NULL,
  "valor"    INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "folio_contadores_pkey" PRIMARY KEY ("tenantId"),
  CONSTRAINT "folio_contadores_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- 2) Columnas nuevas del lead.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "folioPS"            TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "motivoDescarte"     TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "motivoDescarteNota" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "descartadoAt"       TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "descartadoPorId"    INTEGER;

ALTER TABLE "leads" DROP CONSTRAINT IF EXISTS "leads_descartadoPorId_fkey";
ALTER TABLE "leads" ADD CONSTRAINT "leads_descartadoPorId_fkey"
  FOREIGN KEY ("descartadoPorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3) Folio a los leads que ya existen, en orden de llegada, para que el
--    consecutivo refleje la historia real y no el orden del id.
WITH numerados AS (
  SELECT "id", "tenantId",
         ROW_NUMBER() OVER (PARTITION BY "tenantId" ORDER BY "createdAt", "id") AS n
  FROM "leads"
  WHERE "folioPS" IS NULL
)
UPDATE "leads" l
SET "folioPS" = 'PS-' || LPAD(numerados.n::text, 6, '0')
FROM numerados
WHERE l."id" = numerados."id";

-- 4) El contador arranca donde quedo el relleno; si no, el proximo lead
--    chocaria contra el indice unico.
INSERT INTO "folio_contadores" ("tenantId", "valor")
SELECT "tenantId", COUNT(*) FROM "leads" GROUP BY "tenantId"
ON CONFLICT ("tenantId") DO UPDATE SET valor = EXCLUDED.valor;

-- 5) El unico va al final: antes de rellenar habria chocado con los nulos
--    repetidos en algunos motores.
CREATE UNIQUE INDEX IF NOT EXISTS "leads_folioPS_key" ON "leads"("folioPS");
