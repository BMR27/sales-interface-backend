-- Ciclo de vida de leads: resultado de llamada, rellamada, horarios y
-- bitacora de asignaciones.
--
-- NO DESTRUCTIVA: solo agrega. Ninguna columna se borra ni se renombra,
-- ningun dato existente se reescribe. Todo lo nuevo nace con el valor que
-- deja a los leads de hoy comportandose exactamente igual que antes:
--   - substatus / seguimiento / intentos: NULL o false, o sea "sin evaluar"
--   - nombreOriginal: NULL, que significa "nunca se ha editado"
-- Reversion: los DROP equivalentes, sin perdida de informacion previa.

-- 1. El quinto estatus. ALTER TYPE ... ADD VALUE es aditivo: los cuatro
--    existentes conservan su orden y su representacion en disco, asi que
--    ninguna fila se reescribe y ningun indice se invalida.
--    IF NOT EXISTS lo hace repetible si la migracion se reaplica.
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'NO_CONCRETADO';

-- 2. Campos nuevos del lead.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "substatus" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "substatusAt" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "seguimientoIncompleto" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "seguimientoIncompletoAt" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "intentosEsperados" INTEGER;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "intentosRealizados" INTEGER;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "requiereRevisionHorario" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "nombreOriginal" TEXT;

-- La cola de la coordinadora filtra siempre por estas tres columnas.
CREATE INDEX IF NOT EXISTS "leads_tenantId_vendedorId_disponibleDesde_idx"
  ON "leads" ("tenantId", "vendedorId", "disponibleDesde");

-- 3. Bitacora de asignaciones.
CREATE TABLE IF NOT EXISTS "lead_asignaciones" (
  "id" SERIAL NOT NULL,
  "leadId" INTEGER NOT NULL,
  "actorId" INTEGER,
  "actorNombre" TEXT,
  "vendedorAnteriorId" INTEGER,
  "vendedorAnteriorNombre" TEXT,
  "vendedorNuevoId" INTEGER,
  "vendedorNuevoNombre" TEXT,
  "evento" TEXT NOT NULL,
  "resultado" TEXT,
  "motivo" TEXT,
  "automatico" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId" INTEGER NOT NULL,
  CONSTRAINT "lead_asignaciones_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "lead_asignaciones_leadId_createdAt_idx" ON "lead_asignaciones" ("leadId", "createdAt");
CREATE INDEX IF NOT EXISTS "lead_asignaciones_tenantId_createdAt_idx" ON "lead_asignaciones" ("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "lead_asignaciones_vendedorNuevoId_createdAt_idx" ON "lead_asignaciones" ("vendedorNuevoId", "createdAt");

-- 4. Bitacora de cambios de nombre del cliente.
CREATE TABLE IF NOT EXISTS "lead_nombre_cambios" (
  "id" SERIAL NOT NULL,
  "leadId" INTEGER NOT NULL,
  "nombreAntes" TEXT NOT NULL,
  "nombreDespues" TEXT NOT NULL,
  "userId" INTEGER,
  "userNombre" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId" INTEGER NOT NULL,
  CONSTRAINT "lead_nombre_cambios_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "lead_nombre_cambios_leadId_createdAt_idx" ON "lead_nombre_cambios" ("leadId", "createdAt");
CREATE INDEX IF NOT EXISTS "lead_nombre_cambios_tenantId_createdAt_idx" ON "lead_nombre_cambios" ("tenantId", "createdAt");

-- 5. Turnos de las vendedoras.
CREATE TABLE IF NOT EXISTS "horarios_vendedora" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER NOT NULL,
  "diaSemana" INTEGER NOT NULL,
  "horaInicio" INTEGER NOT NULL,
  "horaFin" INTEGER NOT NULL,
  "tenantId" INTEGER NOT NULL,
  CONSTRAINT "horarios_vendedora_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "horarios_vendedora_userId_diaSemana_idx" ON "horarios_vendedora" ("userId", "diaSemana");
CREATE INDEX IF NOT EXISTS "horarios_vendedora_tenantId_idx" ON "horarios_vendedora" ("tenantId");

-- 6. Candado de idempotencia.
CREATE TABLE IF NOT EXISTS "acciones_idempotentes" (
  "token" TEXT NOT NULL,
  "leadId" INTEGER,
  "accion" TEXT NOT NULL,
  "resultado" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId" INTEGER,
  CONSTRAINT "acciones_idempotentes_pkey" PRIMARY KEY ("token")
);

CREATE INDEX IF NOT EXISTS "acciones_idempotentes_createdAt_idx" ON "acciones_idempotentes" ("createdAt");

-- 7. Llaves foraneas. ON DELETE CASCADE en las dos bitacoras ligadas al
--    lead: si algun dia se borra un lead de prueba, su rastro se va con el
--    en vez de dejar filas huerfanas que rompen los conteos.
--    `acciones_idempotentes` NO lleva FK a proposito: es un candado
--    efimero, y una FK la volveria un obstaculo para borrar cualquier cosa.
DO $$ BEGIN
  ALTER TABLE "lead_asignaciones"
    ADD CONSTRAINT "lead_asignaciones_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "lead_nombre_cambios"
    ADD CONSTRAINT "lead_nombre_cambios_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "horarios_vendedora"
    ADD CONSTRAINT "horarios_vendedora_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "horarios_vendedora"
    ADD CONSTRAINT "horarios_vendedora_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
