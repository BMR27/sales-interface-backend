-- FullVector dejó de rechazar los CP fuera de cobertura: ahora crea la
-- orden con trackingStatus NO_COVERAGE. Esta bandera marca esas ventas
-- para gestionarlas como prepago (transferencia + mensajería tradicional).
ALTER TABLE "ventas" ADD COLUMN "fullvectorSinCobertura" BOOLEAN NOT NULL DEFAULT false;
