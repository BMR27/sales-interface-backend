// Avisos dentro de la app: lo que se ve al abrir la campana.
//
// No confundir con src/lib/notificaciones.js, que manda correos a los
// destinatarios que configura el admin. Estos son por persona y por rol, y
// no salen de la aplicación.
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const CATEGORIAS = ["INFO", "EXITO", "ALERTA", "MOTIVACION", "LOGRO"];

// Clave de día, para que los avisos derivados se emitan una vez por jornada
// y no en cada consulta. Fecha local de México: la jornada de ventas se
// corta a la medianoche de aquí, no a la de UTC.
function claveDia(fecha = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(fecha);
}

// Un aviso de evento: cada llamada crea uno nuevo (un lead asignado, una
// venta sincronizada). Nunca lanza: un aviso que falla no puede tumbar la
// operación que lo originó.
async function crearAviso({ userId, tenantId = null, tipo, titulo, mensaje, categoria = "INFO", enlace = null }) {
  try {
    if (!userId) return null;
    return await prisma.notificacion.create({
      data: {
        userId,
        tenantId,
        tipo,
        titulo,
        mensaje,
        enlace,
        categoria: CATEGORIAS.includes(categoria) ? categoria : "INFO",
      },
    });
  } catch (err) {
    console.error("crearAviso falló", tipo, err);
    return null;
  }
}

// Un aviso de hito: se intenta crear con una clave única por usuario y, si
// ya existía, no pasa nada. Así los generadores derivados pueden correr en
// cada consulta sin duplicar nada ni tener que preguntar antes.
async function crearAvisoUnico({ userId, clave, ...resto }) {
  try {
    if (!userId || !clave) return null;
    return await prisma.notificacion.create({
      data: {
        userId,
        clave,
        tenantId: resto.tenantId ?? null,
        tipo: resto.tipo,
        titulo: resto.titulo,
        mensaje: resto.mensaje,
        enlace: resto.enlace ?? null,
        categoria: CATEGORIAS.includes(resto.categoria) ? resto.categoria : "INFO",
      },
    });
  } catch (err) {
    // P2002 = ya existe esa clave para este usuario: el hito ya se avisó.
    if (err?.code !== "P2002") console.error("crearAvisoUnico falló", resto.tipo, err);
    return null;
  }
}

// Varios avisos de evento de golpe (una asignación en lote de leads).
async function crearAvisos(avisos) {
  try {
    const filas = avisos.filter((a) => a.userId);
    if (filas.length === 0) return 0;
    const { count } = await prisma.notificacion.createMany({
      data: filas.map((a) => ({
        userId: a.userId,
        tenantId: a.tenantId ?? null,
        tipo: a.tipo,
        titulo: a.titulo,
        mensaje: a.mensaje,
        enlace: a.enlace ?? null,
        categoria: CATEGORIAS.includes(a.categoria) ? a.categoria : "INFO",
      })),
    });
    return count;
  } catch (err) {
    console.error("crearAvisos falló", err);
    return 0;
  }
}

async function listarAvisos(userId, { limite = 30 } = {}) {
  const [items, noLeidas] = await Promise.all([
    prisma.notificacion.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(limite) || 30, 100),
    }),
    prisma.notificacion.count({ where: { userId, leidaAt: null } }),
  ]);
  return { items, noLeidas };
}

async function marcarLeida(userId, id) {
  const { count } = await prisma.notificacion.updateMany({
    where: { id: Number(id), userId, leidaAt: null },
    data: { leidaAt: new Date() },
  });
  return count;
}

async function marcarTodasLeidas(userId) {
  const { count } = await prisma.notificacion.updateMany({
    where: { userId, leidaAt: null },
    data: { leidaAt: new Date() },
  });
  return count;
}

// La campana no es un archivo histórico: los avisos leídos de hace más de un
// mes sólo hacen más lenta la consulta.
async function purgarViejas(userId) {
  const limite = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  try {
    await prisma.notificacion.deleteMany({
      where: { userId, leidaAt: { not: null }, createdAt: { lt: limite } },
    });
  } catch (err) {
    console.error("purgarViejas falló", err);
  }
}

module.exports = {
  claveDia,
  crearAviso,
  crearAvisoUnico,
  crearAvisos,
  listarAvisos,
  marcarLeida,
  marcarTodasLeidas,
  purgarViejas,
};
