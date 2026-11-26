-- Venta concretada cuyo pago se está gestionando: el cliente generó su
-- ficha OXXO (o su CLABE SPEI) con el link y todavía no paga. La venta
-- existe -- tiene folio -- pero no sale a FullVector hasta que el pago se
-- confirme, y si la ficha vence sin pago se cancela sola.
ALTER TABLE "ventas" ADD COLUMN "pagoPendiente" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ventas" ADD COLUMN "pagoPendienteMetodo" TEXT;
ALTER TABLE "ventas" ADD COLUMN "pagoPendienteHasta" TIMESTAMP(3);
CREATE INDEX "ventas_tenantId_pagoPendiente_idx" ON "ventas"("tenantId", "pagoPendiente");
