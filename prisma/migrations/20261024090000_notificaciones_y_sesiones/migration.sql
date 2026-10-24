-- Avisos en pantalla (la campana) y sesiones activas por usuario.

CREATE TYPE "NotificacionCategoria" AS ENUM ('INFO', 'EXITO', 'ALERTA', 'MOTIVACION', 'LOGRO');

CREATE TABLE "notificaciones" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER,
    "userId" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL,
    "categoria" "NotificacionCategoria" NOT NULL DEFAULT 'INFO',
    "titulo" TEXT NOT NULL,
    "mensaje" TEXT NOT NULL,
    "enlace" TEXT,
    "clave" TEXT,
    "leidaAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notificaciones_pkey" PRIMARY KEY ("id")
);

-- La clave es lo que impide que un hito derivado (meta al 50%, bloque de
-- comision cerrado, motivacion del dia) se avise dos veces.
CREATE UNIQUE INDEX "notificaciones_userId_clave_key" ON "notificaciones"("userId", "clave");
CREATE INDEX "notificaciones_userId_createdAt_idx" ON "notificaciones"("userId", "createdAt");

ALTER TABLE "notificaciones" ADD CONSTRAINT "notificaciones_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "notificaciones" ADD CONSTRAINT "notificaciones_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "sesiones" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "tenantId" INTEGER,
    "dispositivo" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "motivo" TEXT,

    CONSTRAINT "sesiones_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sesiones_userId_revokedAt_idx" ON "sesiones"("userId", "revokedAt");

ALTER TABLE "sesiones" ADD CONSTRAINT "sesiones_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
