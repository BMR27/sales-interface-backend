-- Punto de corte de los intentos de llamada de un lead.
--
-- Lo necesita la reactivacion de descartados: un lead descartado por "no
-- contesto" arrastra sus intentos viejos, y al volver a la cola el
-- protocolo lo descartaria de nuevo en la primera llamada. Con esta fecha,
-- los intentos se cuentan desde que se reactivo.
--
-- Null en todos los leads existentes: cuentan todas sus llamadas, que es el
-- comportamiento de siempre.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "reintentosDesde" TIMESTAMP(3);
