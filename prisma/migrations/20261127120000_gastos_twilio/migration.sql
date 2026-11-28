-- Gasto de Twilio (llamadas, SMS, WhatsApp, grabaciones) contra lo que se
-- recarga. Informativo: el saldo real vive en Twilio (y la cuenta es
-- compartida); esto es lo que gasta este espacio, calculado con sus
-- propios registros y las tarifas configuradas.

-- Recargas de saldo, en pesos.
CREATE TABLE "recargas_twilio" (
  "id" SERIAL NOT NULL,
  "tenantId" INTEGER NOT NULL,
  "monto" DOUBLE PRECISION NOT NULL,
  "fecha" TIMESTAMP(3) NOT NULL,
  "nota" TEXT,
  "creadoPorId" INTEGER,
  "creadoPorNombre" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recargas_twilio_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "recargas_twilio_tenantId_fecha_idx" ON "recargas_twilio"("tenantId", "fecha");
ALTER TABLE "recargas_twilio" ADD CONSTRAINT "recargas_twilio_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cada SMS o WhatsApp que sale, con quién lo mandó y cuántos segmentos
-- cobró Twilio. Antes sólo quedaban los del link de pago.
CREATE TABLE "mensajes_enviados" (
  "id" SERIAL NOT NULL,
  "tenantId" INTEGER NOT NULL,
  "userId" INTEGER,
  "leadId" INTEGER,
  "canal" TEXT NOT NULL,
  "motivo" TEXT NOT NULL,
  "segmentos" INTEGER NOT NULL DEFAULT 1,
  "twilioSid" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mensajes_enviados_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mensajes_enviados_twilioSid_key" ON "mensajes_enviados"("twilioSid");
CREATE INDEX "mensajes_enviados_tenantId_createdAt_idx" ON "mensajes_enviados"("tenantId", "createdAt");
ALTER TABLE "mensajes_enviados" ADD CONSTRAINT "mensajes_enviados_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
