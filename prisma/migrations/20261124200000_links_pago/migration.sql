-- Links de cobro de Stripe (tarjeta, OXXO y SPEI) que se le mandan al
-- cliente por SMS a media llamada. Cuelgan del lead, no de la venta: en
-- media llamada la venta todavía no existe (ver model LinkPago).

-- CreateEnum
CREATE TYPE "LinkPagoEstado" AS ENUM ('ENVIADO', 'PENDIENTE_PAGO', 'PAGADO', 'VENCIDO', 'FALLIDO');

-- CreateTable
CREATE TABLE "links_pago" (
    "id" SERIAL NOT NULL,
    "leadId" INTEGER NOT NULL,
    "stripeSessionId" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "stripePaymentIntentId" TEXT,
    "url" TEXT NOT NULL,
    "monto" DOUBLE PRECISION NOT NULL,
    "estado" "LinkPagoEstado" NOT NULL DEFAULT 'ENVIADO',
    "metodo" TEXT,
    "enviadoA" TEXT NOT NULL,
    "smsSid" TEXT,
    "smsError" TEXT,
    "enviadoPorId" INTEGER,
    "enviadoPorNombre" TEXT,
    "expiraAt" TIMESTAMP(3) NOT NULL,
    "pagadoAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" INTEGER NOT NULL,

    CONSTRAINT "links_pago_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "links_pago_stripeSessionId_key" ON "links_pago"("stripeSessionId");

-- CreateIndex
CREATE INDEX "links_pago_leadId_idx" ON "links_pago"("leadId");

-- AddForeignKey
ALTER TABLE "links_pago" ADD CONSTRAINT "links_pago_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "links_pago" ADD CONSTRAINT "links_pago_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
