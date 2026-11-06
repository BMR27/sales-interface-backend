-- Numeros que no se deben volver a contactar.
--
-- El motivo de descarte BLACKLIST ya existia, pero no habia donde guardar
-- la lista: marcarlo era una observacion suelta de la vendedora en un
-- lead, y el mismo numero volvia a entrar al dia siguiente sin que nadie
-- se enterara. Esta es la tabla que faltaba.
--
-- `telefono` guarda la CLAVE de comparacion -- los ultimos 10 digitos, sin
-- lada de pais ni signos -- y no el texto tal como se escribio. El mismo
-- numero llega de cuatro formas distintas ("+524151026124",
-- "524151026124", "4151026124", "415 102 6124") y compararlos como texto
-- los trata como numeros diferentes, que es justo lo que haria inutil la
-- lista. El original se conserva aparte, para poder mostrarlo como se
-- captur0.
CREATE TABLE IF NOT EXISTS "numeros_bloqueados" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "telefono" TEXT NOT NULL,
    "telefonoOriginal" TEXT,
    "motivo" TEXT NOT NULL,
    "nota" TEXT,
    "creadoPorId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "numeros_bloqueados_pkey" PRIMARY KEY ("id")
);

-- Un numero no puede estar dos veces en la lista de la misma empresa. Es
-- tambien el indice con el que la ingesta lo busca en cada lead que entra,
-- asi que tiene que ser una igualdad indexada y no un recorrido.
CREATE UNIQUE INDEX IF NOT EXISTS "numeros_bloqueados_tenantId_telefono_key"
  ON "numeros_bloqueados"("tenantId", "telefono");

DO $$ BEGIN
  ALTER TABLE "numeros_bloqueados" ADD CONSTRAINT "numeros_bloqueados_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Quien lo bloqueo. Se pone en NULL si el usuario se da de baja: el
-- bloqueo sigue valiendo aunque quien lo puso ya no este.
DO $$ BEGIN
  ALTER TABLE "numeros_bloqueados" ADD CONSTRAINT "numeros_bloqueados_creadoPorId_fkey"
    FOREIGN KEY ("creadoPorId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- La deteccion de repetidos agrupa por estas dos columnas sobre toda la
-- tabla de leads. Sin indices es un recorrido completo en cada carga de la
-- pantalla.
CREATE INDEX IF NOT EXISTS "leads_tenantId_telefono_idx" ON "leads"("tenantId", "telefono");
CREATE INDEX IF NOT EXISTS "leads_tenantId_nombre_idx" ON "leads"("tenantId", "nombre");
