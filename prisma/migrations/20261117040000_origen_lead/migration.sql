-- De donde viene cada lead: del proveedor o de la landing propia.
--
-- Hasta ahora el lead solo distinguia MANUAL de EXTERNAL_API, y eso dejo
-- de alcanzar en cuanto la landing de Perfect Self empezo a entrar por la
-- misma API que CashFactories: los dos son EXTERNAL_API y en pantalla se
-- ven igual. La diferencia no es cosmetica -- un lead de la landing lo
-- genero nuestra campaña y el cliente nos busco; uno de CF se compro --
-- asi que la vendedora encara la llamada distinto y el costo por lead no
-- es el mismo.
--
-- El origen cuelga de la API KEY y no se adivina del payload: es un dato
-- de quien integra, no del lead, y cada integracion sabe quien es. Al
-- crear el lead se copia, para que el feed no tenga que cruzar dos tablas
-- en cada tarjeta.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "origen" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "origen" TEXT;

-- Las integraciones que ya existen. Se identifican por su etiqueta porque
-- los ids no son estables entre entornos.
UPDATE "api_keys" SET "origen" = 'CF'
 WHERE "origen" IS NULL AND "label" ILIKE '%cashfactories%';

UPDATE "api_keys" SET "origen" = 'PS'
 WHERE "origen" IS NULL AND ("label" ILIKE '%landing%' OR "label" ILIKE '%perfectself%');

-- Los leads que ya entraron: su origen sale de la key por la que llegaron.
-- Se hace aqui y no en un script aparte para que la columna nazca con
-- sentido: un reporte corrido entre la migracion y el backfill mostraria
-- 677 leads sin origen y haria dudar del dato.
UPDATE "leads" l
   SET "origen" = k."origen"
  FROM "incoming_leads" i
  JOIN "api_keys" k ON k."id" = i."apiKeyId"
 WHERE i."assignedLeadId" = l."id"
   AND l."origen" IS NULL
   AND k."origen" IS NOT NULL;

-- El feed filtra y agrupa por origen.
CREATE INDEX IF NOT EXISTS "leads_tenantId_origen_idx" ON "leads"("tenantId", "origen");
