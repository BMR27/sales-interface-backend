-- El ticket de comisión de un día de trabajo.
--
-- Hasta ahora la comisión era un número vivo: se recalculaba entera cada
-- vez que se confirmaba una entrega o se cancelaba una venta, y la
-- vendedora veía una cifra que podía cambiar al día siguiente sin que
-- nadie le dijera por qué. Eso sirve para saber cuánto va ganando, no
-- para cobrar.
--
-- Un ticket es lo contrario: se cierra al final de la jornada, se congela,
-- y de ahí en adelante lo que cambia es su ESTATUS, no su importe.
--
--   EN_APROBACION  esperando que la coordinadora revise que las órdenes y
--                  los importes están bien
--   APROBADO       la coordinadora lo revisó. Su firma queda registrada
--   LIQUIDADO      la vendedora recibió el pago y lo firmó con su
--                  contraseña
--
-- `detalle` guarda las ventas que lo componen tal como estaban ese día.
-- Va como JSON y no como relación a propósito: si mañana se cancela una
-- de esas ventas, el ticket que ya se firmó no puede cambiar -- fue lo que
-- se pagó, y lo que se corrige es el ticket siguiente, no la historia.
CREATE TABLE IF NOT EXISTS "tickets_comision" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "vendedorId" INTEGER NOT NULL,
    -- El día de la jornada, a medianoche en el huso de la operación.
    "fecha" DATE NOT NULL,
    "piezas" INTEGER NOT NULL DEFAULT 0,
    "ventas" INTEGER NOT NULL DEFAULT 0,
    "monto" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "detalle" JSONB,
    "estatus" TEXT NOT NULL DEFAULT 'EN_APROBACION',

    -- La firma de la coordinadora es el acto de aprobar.
    "aprobadoPorId" INTEGER,
    "aprobadoAt" TIMESTAMP(3),
    -- La de la vendedora es el acuse de que recibió el pago.
    "firmadoAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tickets_comision_pkey" PRIMARY KEY ("id")
);

-- Un solo ticket por vendedora y día: es lo que impide que una segunda
-- corrida del cierre genere un duplicado y se pague dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS "tickets_comision_tenantId_vendedorId_fecha_key"
  ON "tickets_comision"("tenantId", "vendedorId", "fecha");

CREATE INDEX IF NOT EXISTS "tickets_comision_tenantId_estatus_idx"
  ON "tickets_comision"("tenantId", "estatus");

DO $$ BEGIN
  ALTER TABLE "tickets_comision" ADD CONSTRAINT "tickets_comision_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "tickets_comision" ADD CONSTRAINT "tickets_comision_vendedorId_fkey"
    FOREIGN KEY ("vendedorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Quien aprobó se queda en NULL si se da de baja: la aprobación siguió
-- ocurriendo aunque esa persona ya no esté.
DO $$ BEGIN
  ALTER TABLE "tickets_comision" ADD CONSTRAINT "tickets_comision_aprobadoPorId_fkey"
    FOREIGN KEY ("aprobadoPorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
