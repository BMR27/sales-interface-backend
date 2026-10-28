-- Protocolo de reintento, supervision y solicitudes especiales.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "disponibleDesde"     TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "requiereSupervision" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "supervisionNota"     TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "supervisionPedidaAt" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "solicitudEspecial"   TEXT;

-- La cola filtra por estos dos en cada carga.
CREATE INDEX IF NOT EXISTS "leads_disponibleDesde_idx" ON "leads"("disponibleDesde");
CREATE INDEX IF NOT EXISTS "leads_requiereSupervision_idx" ON "leads"("requiereSupervision");
