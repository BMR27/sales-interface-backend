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

const OFFSET_MINUTOS = (() => {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(OFFSET);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
})();

// Corre el instante al huso de la operacion para poder leerle el dia y la
// hora con los getters UTC. Es el mismo truco de siempre: no se cambia el
// momento, se cambia desde donde se mira.
function enHusoLocal(fecha) {
  return new Date(fecha.getTime() + OFFSET_MINUTOS * 60000);
}

// El dia de calendario al que pertenece un instante, visto desde Mexico.
// Agrupar series por `toISOString()` a secas parte los dias a las 18:00.
function diaLocal(fecha) {
  return enHusoLocal(fecha).toISOString().slice(0, 10);
}

// La hora del reloj de la operacion, 0-23. `getHours()` daria la del
// servidor, que corre en UTC y reportaria las llamadas seis horas corridas.
function horaLocal(fecha) {
  return enHusoLocal(fecha).getUTCHours();
}

function inicioDeHoy(ref = new Date()) {
  return inicioDeDia(diaLocal(ref));
}

function inicioDeMes(ref = new Date()) {
  return inicioDeDia(`${diaLocal(ref).slice(0, 8)}01`);
}

function inicioDeAno(ref = new Date()) {
  return inicioDeDia(`${diaLocal(ref).slice(0, 4)}-01-01`);
}

module.exports = {
  inicioDeDia, finDeDia, rangoFechas, OFFSET,
  diaLocal, horaLocal, inicioDeHoy, inicioDeMes, inicioDeAno,
};
