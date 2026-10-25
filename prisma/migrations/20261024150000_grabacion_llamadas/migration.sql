-- Indice de grabaciones de llamadas. El audio vive en Twilio; aqui solo se
-- guarda a que lead y a que vendedora corresponde cada una, para poder
-- servirlo por proxy con rol ADMIN (ver src/routes/grabaciones.js).

CREATE TYPE "GrabacionEstado" AS ENUM ('EN_CURSO', 'COMPLETADA', 'FALLIDA', 'BORRADA');

CREATE TABLE "grabaciones_llamadas" (
    "id" SERIAL NOT NULL,
    "callSid" TEXT NOT NULL,
    "recordingSid" TEXT,
    "estado" "GrabacionEstado" NOT NULL DEFAULT 'EN_CURSO',
    "duracion" INTEGER,
    "grabadaAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leadId" INTEGER,
    "vendedorId" INTEGER,
    "tenantId" INTEGER NOT NULL,

    CONSTRAINT "grabaciones_llamadas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "grabaciones_llamadas_callSid_key" ON "grabaciones_llamadas"("callSid");
CREATE UNIQUE INDEX "grabaciones_llamadas_recordingSid_key" ON "grabaciones_llamadas"("recordingSid");
CREATE INDEX "grabaciones_llamadas_tenantId_createdAt_idx" ON "grabaciones_llamadas"("tenantId", "createdAt");
CREATE INDEX "grabaciones_llamadas_leadId_idx" ON "grabaciones_llamadas"("leadId");

ALTER TABLE "grabaciones_llamadas" ADD CONSTRAINT "grabaciones_llamadas_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "grabaciones_llamadas" ADD CONSTRAINT "grabaciones_llamadas_vendedorId_fkey" FOREIGN KEY ("vendedorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "grabaciones_llamadas" ADD CONSTRAINT "grabaciones_llamadas_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
