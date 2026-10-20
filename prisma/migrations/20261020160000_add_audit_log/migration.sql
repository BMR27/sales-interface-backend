-- Kardex: bitácora de movimientos del sistema (ver src/lib/auditoria.js).

CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" INTEGER,
    "userId" INTEGER,
    "userNombre" TEXT,
    "userEmail" TEXT,
    "userRol" TEXT,
    "accion" TEXT NOT NULL,
    "entidad" TEXT,
    "entidadId" TEXT,
    "descripcion" TEXT NOT NULL,
    "antes" JSONB,
    "despues" JSONB,
    "cambios" JSONB,
    "origen" TEXT NOT NULL DEFAULT 'web',
    "metodo" TEXT,
    "ruta" TEXT,
    "statusCode" INTEGER,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_logs_tenantId_createdAt_idx" ON "audit_logs"("tenantId", "createdAt");
CREATE INDEX "audit_logs_entidad_entidadId_idx" ON "audit_logs"("entidad", "entidadId");
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
