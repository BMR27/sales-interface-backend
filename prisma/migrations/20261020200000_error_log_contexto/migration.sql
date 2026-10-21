-- Contexto del request en los errores de monitoreo: sin esto un error solo
-- decia que trono, no desde donde ni con que cliente.
ALTER TABLE "error_logs" ADD COLUMN "ip" TEXT;
ALTER TABLE "error_logs" ADD COLUMN "userAgent" TEXT;
ALTER TABLE "error_logs" ADD COLUMN "origin" TEXT;
