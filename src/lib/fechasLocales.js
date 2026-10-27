// Limites de dia en la zona horaria de la operacion, no en la del servidor.
//
// Los filtros de fecha llegan como "YYYY-MM-DD" desde un <input type="date">,
// que es un dia del calendario de quien lo escribe. `new Date("2026-10-26")`
// lo interpreta como medianoche UTC, y el servidor corre en UTC: filtrar por
// "26 de octubre" dejaba fuera todo lo ocurrido despues de las 18:00 de
// Mexico, porque ya pertenece al 27 en UTC.
//
// En la practica el filtro parecia roto: se elegia el dia de hoy y las
// llamadas de la tarde desaparecian.
//
// Mexico no aplica horario de verano desde 2022, asi que el offset es fijo.
// Si algun dia hay empresas en otra zona, esto es lo unico que habria que
// volver configurable por tenant.
const OFFSET = process.env.TZ_OFFSET_OPERACION || "-06:00";

// "2026-10-26" -> Date del instante en que empieza ese dia en Mexico.
function inicioDeDia(valor) {
  if (!valor) return null;
  const texto = String(valor).trim();
  const d = texto.length === 10 ? new Date(`${texto}T00:00:00${OFFSET}`) : new Date(texto);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "2026-10-26" -> Date del ultimo instante de ese dia en Mexico. Un dia
// suelto se incluye completo: un rango 26-26 tiene que traer el dia entero.
function finDeDia(valor) {
  if (!valor) return null;
  const texto = String(valor).trim();
  const d = texto.length === 10 ? new Date(`${texto}T23:59:59.999${OFFSET}`) : new Date(texto);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Devuelve el filtro de Prisma para un rango, o null si no hay fechas.
function rangoFechas(desde, hasta) {
  const inicio = inicioDeDia(desde);
  const fin = finDeDia(hasta);
  if (!inicio && !fin) return null;
  return { ...(inicio ? { gte: inicio } : {}), ...(fin ? { lte: fin } : {}) };
}

module.exports = { inicioDeDia, finDeDia, rangoFechas, OFFSET };
