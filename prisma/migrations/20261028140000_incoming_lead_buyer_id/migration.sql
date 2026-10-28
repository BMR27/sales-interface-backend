-- Identificador del comprador en el sistema del proveedor. Hasta ahora, si
-- lo mandaban, quedaba enterrado en rawPayload: no se devolvia en las
-- consultas de estatus ni se podia filtrar por el.
ALTER TABLE "incoming_leads" ADD COLUMN IF NOT EXISTS "buyerId" TEXT;

-- Rellena los leads que ya habian llegado con el campo dentro del payload
-- crudo, para que el historico tambien se pueda conciliar. Se aceptan las
-- dos grafias porque no controlamos como lo escribe cada proveedor.
UPDATE "incoming_leads"
SET "buyerId" = COALESCE(
  "rawPayload" ->> 'buyerId',
  "rawPayload" ->> 'buyer_id'
)
WHERE "buyerId" IS NULL
  AND "rawPayload" IS NOT NULL
  AND COALESCE("rawPayload" ->> 'buyerId', "rawPayload" ->> 'buyer_id') IS NOT NULL;

-- El proveedor va a listar por este campo.
CREATE INDEX IF NOT EXISTS "incoming_leads_buyerId_idx" ON "incoming_leads"("apiKeyId", "buyerId");
