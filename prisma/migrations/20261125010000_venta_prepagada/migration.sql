-- Ventas pagadas en línea (landing PerfectSelf con Stripe).
ALTER TABLE "ventas" ADD COLUMN "prepagada" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ventas" ADD COLUMN "sinComision" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ventas" ADD COLUMN "pagoProveedor" TEXT;
ALTER TABLE "ventas" ADD COLUMN "pagoReferencia" TEXT;
ALTER TABLE "ventas" ADD COLUMN "pagadoAt" TIMESTAMP(3);
ALTER TABLE "ventas" ADD COLUMN "comprobanteUrl" TEXT;
