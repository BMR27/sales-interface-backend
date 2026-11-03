-- Reagenda con prioridad de vuelta.
--
-- El protocolo pide que, al llegar la hora, la coordinadora reasigne con
-- prioridad a la vendedora que atendio la llamada donde se pidio la
-- reagenda: ya hablo con el cliente. Sin este campo no habia forma de
-- saber quien fue.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "reagendaVendedorSugeridoId" INTEGER;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "reagendaAvisadaAt" TIMESTAMP(3);

DO $$ BEGIN
  ALTER TABLE "leads" ADD CONSTRAINT "leads_reagendaVendedorSugeridoId_fkey"
    FOREIGN KEY ("reagendaVendedorSugeridoId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- El tick de alertas barre por la hora de la reagenda.
CREATE INDEX IF NOT EXISTS "leads_fechaReagenda_idx" ON "leads"("fechaReagenda");
