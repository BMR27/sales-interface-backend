-- Asignacion manual: un lead puede entrar sin vendedora y esperar en la cola
-- del coordinador hasta que alguien lo asigne.
ALTER TABLE "leads" ALTER COLUMN "vendedorId" DROP NOT NULL;
