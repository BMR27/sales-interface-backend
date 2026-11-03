-- Protocolo de secuencialidad de llamada.
--
-- El reintento deja de medirse en numero de intentos y pasa a medirse en
-- tiempo: una ventana de reasignacion que depende de como termino la
-- llamada (2h no contesta, 3h rechaza, 4h fuera de servicio) y un corte
-- duro a las 72 horas contadas desde el PRIMER intento.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "disponibleHasta"  TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "primeraLlamadaAt" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "ultimoDesenlace"  TEXT;

-- Los leads que ya tienen llamadas estrenan el reloj con su primer intento
-- real. Sin esto, el corte de 72 horas no sabria desde cuando contar.
UPDATE "leads" l
SET "primeraLlamadaAt" = sub."primera"
FROM (SELECT "leadId", MIN("fecha") AS "primera" FROM "llamadas" GROUP BY "leadId") sub
WHERE l."id" = sub."leadId" AND l."primeraLlamadaAt" IS NULL;

-- El job de las 72 horas barre por esta columna en cada corrida.
CREATE INDEX IF NOT EXISTS "leads_primeraLlamadaAt_idx" ON "leads"("primeraLlamadaAt");
