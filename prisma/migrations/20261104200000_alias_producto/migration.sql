-- Los nombres con que los proveedores mandan cada producto.
--
-- El proveedor manda "Prosta Vital Men" donde el catalogo dice "Vital Men
-- Balance". No es un error de dedo que se arregle normalizando: son dos
-- nombres comerciales distintos de la misma cosa, y no hay forma de
-- deducir uno del otro. Sin esta tabla el lead nacia con productoId NULL y
-- la vendedora abria la llamada sin precio, sin speech y sin promociones,
-- con un aviso de que el producto no estaba en el catalogo -- cuando si
-- estaba.
--
-- `aliasNorm` guarda el alias ya normalizado (sin acentos, sin espacios de
-- mas, en minusculas) para que la busqueda sea una igualdad indexada y no
-- un recorrido comparando en JavaScript.
--
-- Unico por tenant y no por producto: un mismo nombre de proveedor no
-- puede apuntar a dos productos a la vez, que es justo la ambiguedad que
-- deja leads enlazados al producto equivocado.
CREATE TABLE IF NOT EXISTS "producto_alias" (
    "id" SERIAL NOT NULL,
    "productoId" INTEGER NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "alias" TEXT NOT NULL,
    "aliasNorm" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "producto_alias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "producto_alias_tenantId_aliasNorm_key"
  ON "producto_alias"("tenantId", "aliasNorm");

CREATE INDEX IF NOT EXISTS "producto_alias_productoId_idx"
  ON "producto_alias"("productoId");

DO $$ BEGIN
  ALTER TABLE "producto_alias" ADD CONSTRAINT "producto_alias_productoId_fkey"
    FOREIGN KEY ("productoId") REFERENCES "productos"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "producto_alias" ADD CONSTRAINT "producto_alias_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
