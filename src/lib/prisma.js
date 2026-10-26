// Cliente de Prisma compartido por toda la aplicacion.
//
// Antes cada archivo hacia su propio `new PrismaClient()` -- llegaron a ser
// 41. Cada instancia abre su propio pool de conexiones (por defecto
// cpus*2+1), asi que el proceso pedia del orden de 200 conexiones contra un
// Postgres que admite 100. El resultado no era una caida limpia sino algo
// peor de diagnosticar: unas rutas respondian y otras devolvian 500 al
// instante, segun quien alcanzara conexion.
//
// Con una sola instancia hay un solo pool. Prisma lo comparte entre todas
// las consultas sin que haya que coordinar nada.
const { PrismaClient } = require("@prisma/client");

// En desarrollo, el recargado de modulos puede volver a evaluar este archivo
// y crear clientes nuevos cada vez. Guardarlo en global evita esa fuga.
const globalParaPrisma = globalThis;

const prisma = globalParaPrisma.__prisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalParaPrisma.__prisma = prisma;
}

module.exports = prisma;
