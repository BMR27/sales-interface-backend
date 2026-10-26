// Una sola sesion activa por usuario.
//
// El JWT por si solo no se puede invalidar antes de que expire, asi que cada
// login crea una fila en `sesiones` y el token lleva su id en `sid`. El
// middleware de auth revisa esa fila en cada petición: revocarla cierra la
// sesión en el acto, que es justo lo que hace falta cuando alguien entra
// desde otro dispositivo y decide cerrar la sesión anterior.
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Las sesiones viven lo mismo que el token (ver routes/auth.js).
const DURACION_HORAS = 8;

// Revisar la tabla en cada petición costaría una consulta por request. Como
// una sesión sólo cambia de estado al revocarse, se cachea el resultado unos
// segundos: el cierre remoto tarda a lo mucho ese tiempo en notarse, y a
// cambio el grueso del tráfico no toca la base.
const TTL_CACHE_MS = 15_000;
const cache = new Map();

function invalidarCache(sid) {
  cache.delete(sid);
}

// "Chrome en Mac" es más útil que el user-agent crudo cuando hay que
// decirle a alguien dónde tiene la otra sesión abierta.
function describirDispositivo(userAgent) {
  const ua = String(userAgent || "");
  if (!ua) return "Dispositivo desconocido";

  const navegador =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Chrome\//.test(ua) && !/Chromium/.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : "Navegador";

  const sistema =
    /iPhone|iPad|iPod/.test(ua) ? "iPhone/iPad"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : null;

  return sistema ? `${navegador} en ${sistema}` : navegador;
}

function ipDe(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null;
}

// La sesión viva de un usuario, si la hay. Las expiradas no cuentan: no
// tiene sentido pedirle a alguien que cierre una sesión que ya murió sola.
async function sesionActivaDe(userId) {
  return prisma.sesion.findFirst({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
  });
}

async function crearSesion(user, req) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + DURACION_HORAS * 60 * 60 * 1000);
  const userAgent = req?.headers?.["user-agent"] || null;

  await prisma.sesion.create({
    data: {
      id,
      userId: user.id,
      tenantId: user.tenantId ?? null,
      dispositivo: describirDispositivo(userAgent),
      userAgent,
      ip: req ? ipDe(req) : null,
      expiresAt,
    },
  });

  return { id, expiresAt };
}

// Cierra las sesiones vivas de un usuario. `exceptoId` permite revocar "las
// demás" sin tumbar la que se acaba de crear.
async function revocarSesiones(userId, { motivo = "cerrada", exceptoId = null } = {}) {
  const vivas = await prisma.sesion.findMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptoId ? { id: { not: exceptoId } } : {}),
    },
    select: { id: true },
  });
  if (vivas.length === 0) return 0;

  await prisma.sesion.updateMany({
    where: { id: { in: vivas.map((s) => s.id) } },
    data: { revokedAt: new Date(), motivo },
  });
  for (const s of vivas) invalidarCache(s.id);

  return vivas.length;
}

// Devuelve { ok } o { ok: false, motivo } para que el middleware pueda
// explicarle a la persona por qué la sacaron, en vez de un 401 pelón.
async function validarSesion(sid) {
  const enCache = cache.get(sid);
  if (enCache && enCache.hasta > Date.now()) return enCache.resultado;

  const sesion = await prisma.sesion.findUnique({ where: { id: sid } });

  let resultado;
  if (!sesion) resultado = { ok: false, motivo: "desconocida" };
  else if (sesion.revokedAt) resultado = { ok: false, motivo: sesion.motivo || "cerrada" };
  else if (sesion.expiresAt <= new Date()) resultado = { ok: false, motivo: "expirada" };
  else resultado = { ok: true };

  cache.set(sid, { resultado, hasta: Date.now() + TTL_CACHE_MS });

  // `lastSeenAt` se refresca sólo cuando la sesión sale del caché, no en cada
  // petición: sirve para ordenar y para mostrar "activa desde", no para
  // medir al segundo.
  if (resultado.ok) {
    prisma.sesion
      .update({ where: { id: sid }, data: { lastSeenAt: new Date() } })
      .catch(() => {});
  }

  return resultado;
}

module.exports = {
  DURACION_HORAS,
  describirDispositivo,
  sesionActivaDe,
  crearSesion,
  revocarSesiones,
  validarSesion,
  invalidarCache,
};
