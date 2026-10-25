-- Historial de intentos de llamada por lead.
--
-- `llamadas` pasa de ser "resultados registrados" a ser el registro de cada
-- intento: quien marco, cuando, si contestaron y en que estatus quedo el
-- lead. Las filas que ya existian conservan su significado -- son intentos
-- contestados cuyo resultado se registro -- asi que `contestada` se pone en
-- true para ellas y no en el default.

ALTER TABLE "llamadas" ADD COLUMN "callSid" TEXT;
ALTER TABLE "llamadas" ADD COLUMN "desenlace" TEXT;
ALTER TABLE "llamadas" ADD COLUMN "contestada" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "llamadas" ADD COLUMN "estadoAntes" "LeadStatus";
ALTER TABLE "llamadas" ADD COLUMN "estadoDespues" "LeadStatus";

CREATE UNIQUE INDEX "llamadas_callSid_key" ON "llamadas"("callSid");
CREATE INDEX "llamadas_leadId_fecha_idx" ON "llamadas"("leadId", "fecha");

-- Lo historico se escribio solo al confirmar o reagendar, y ambas cosas
-- requieren haber hablado con el cliente.
UPDATE "llamadas" SET "contestada" = true;
