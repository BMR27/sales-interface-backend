-- Cola anterior/nueva y proxima disponibilidad en la bitacora de
-- asignaciones.
--
-- Los pide la seccion 7 del documento ("Historial obligatorio"): hasta
-- ahora la bitacora decia quien movio el lead y por que, pero no DE DONDE a
-- donde, y la hora de la proxima accion iba embebida en el texto del
-- motivo, de donde no se puede consultar.
--
-- NO DESTRUCTIVA: solo agrega tres columnas nullables. Las filas que ya
-- existen quedan con NULL, que es lo correcto -- significa "no se
-- registro", no "estaba vacio": esos movimientos ocurrieron antes de que
-- se guardara el dato y no se puede reconstruir sin inventarlo.
ALTER TABLE "lead_asignaciones" ADD COLUMN IF NOT EXISTS "colaAntes" TEXT;
ALTER TABLE "lead_asignaciones" ADD COLUMN IF NOT EXISTS "colaDespues" TEXT;
ALTER TABLE "lead_asignaciones" ADD COLUMN IF NOT EXISTS "proximaAccionAt" TIMESTAMP(3);
