// Cliente de Prisma compartido por toda la aplicacion.
//
// Antes cada archivo hacia su propio `new PrismaClient()` -- llegaron a ser
// 41. Cada instancia abre su propio pool, asi que el proceso pedia del orden
// de 200 conexiones contra un Postgres que admite 100. El sintoma no era una
// caida limpia sino unas rutas respondiendo 200 y otras 500 en 170ms, segun
// cual alcanzara conexion.
//
// El tamaño del pool se fija explicitamente y esto NO es un detalle menor:
// el default de Prisma es cpus*2+1, que en un contenedor de Railway son 3 o
// 5 conexiones. Con 41 clientes eso sobraba; con uno solo, ese mismo default
// deja a TODA la aplicacion con 5 conexiones, las peticiones se encolan y
// el servicio empieza a devolver 502. Pasó: el primer intento de esta misma
// correccion tumbo produccion por no fijarlo.
//
// 20 conexiones es holgado para un pool unico y queda muy por debajo del
// limite de Postgres.
const { PrismaClient } = require("@prisma/client");

const CONEXIONES = Number(process.env.PRISMA_CONNECTION_LIMIT) || 20;
const ESPERA_POOL_S = Number(process.env.PRISMA_POOL_TIMEOUT) || 20;

// Prisma lee el tamaño del pool de la query string de la URL, no de una
// opcion del constructor. Se añade solo si no viene ya puesta, para que
// configurarlo desde la variable de entorno siga mandando.
function urlConPool() {
  const base = process.env.DATABASE_URL;
  if (!base) return undefined;
  try {
    const u = new URL(base);
    if (!u.searchParams.has("connection_limit")) {
      u.searchParams.set("connection_limit", String(CONEXIONES));
    }
    if (!u.searchParams.has("pool_timeout")) {
      u.searchParams.set("pool_timeout", String(ESPERA_POOL_S));
    }
    return u.toString();
  } catch {
    // URL con formato inesperado: mejor arrancar con la original que no
    // arrancar.
    return base;
  }
}

function crear() {
  const url = urlConPool();
  return url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();
}

// En desarrollo, el recargado de modulos puede volver a evaluar este archivo
// y crear clientes nuevos cada vez. Guardarlo en global evita esa fuga.
const globalParaPrisma = globalThis;
const prisma = globalParaPrisma.__prisma || crear();

if (process.env.NODE_ENV !== "production") {
  globalParaPrisma.__prisma = prisma;
}

module.exports = prisma;
