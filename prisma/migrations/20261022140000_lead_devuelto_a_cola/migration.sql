-- Un lead que la vendedora devuelve a la cola al cerrar su turno porque el
-- cliente no contesto. Permite que la coordinadora lo reasigne a otra
-- persona en vez de desaprovecharlo.
ALTER TABLE "leads" ADD COLUMN     "devueltoAt" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN     "devueltoMotivo" TEXT;
ALTER TABLE "leads" ADD COLUMN     "devueltoPorNombre" TEXT;
