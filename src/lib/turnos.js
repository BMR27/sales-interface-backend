// Turno matutino y vespertino.
//
// La operación trabaja en dos turnos partidos por la comida:
//
//   matutino    08:00 a 12:00
//   vespertino  13:00 a 18:00
//
// El sistema ya guardaba el horario de cada vendedora (día de la semana,
// hora de inicio y de fin), pero no tenía el concepto de TURNO, y el
// reparto automático lo necesita: el documento pide reservar leads para
// el vespertino y devolver las rellamadas a quien esté en el turno en que
// se pactaron.
//
// El turno NO se captura aparte: se DEDUCE del horario que ya existe. Dos
// fuentes para el mismo dato se contradicen en cuanto alguien edita una
// sola, y aquí la que manda es el horario, que es lo que de verdad
// gobierna si alguien puede trabajar.
//
// Dónde cae el corte: a mediodía, en la hora de comida. Quien empieza
// antes de las 12:00 es del matutino; quien empieza a las 12:00 o después
// es del vespertino. Una vendedora de jornada completa (8 a 18) cubre los
// dos, y así se la trata: cuenta para los dos repartos.
const { evaluarTurno, horariosDe, momentoLocal } = require("./horariosVendedora");

const MATUTINO = "MATUTINO";
const VESPERTINO = "VESPERTINO";
const COMPLETO = "COMPLETO";

// El minuto del día que separa un turno del otro: 12:00.
const CORTE_MINUTO = 12 * 60;

// A qué turno pertenece una franja suelta.
function turnoDeFranja(franja) {
  if (franja.horaInicio < CORTE_MINUTO && franja.horaFin > CORTE_MINUTO) return COMPLETO;
  return franja.horaInicio < CORTE_MINUTO ? MATUTINO : VESPERTINO;
}

// El turno de una vendedora EN UN DÍA concreto.
//
// Se mira el día y no la semana entera porque los horarios pueden
// cambiar: alguien puede ser matutina los lunes y vespertina los sábados,
// y repartirle leads de la mañana un sábado sería dejarlos sin trabajar.
//
// Devuelve null si ese día no trabaja: no es "ningún turno", es que no
// entra en el reparto.
function turnoDelDia(horarios, fecha = new Date()) {
  const { diaSemana } = momentoLocal(fecha);
  const delDia = (horarios || []).filter((h) => h.diaSemana === diaSemana);
  if (delDia.length === 0) return null;

  const turnos = new Set(delDia.map(turnoDeFranja));
  if (turnos.has(COMPLETO)) return COMPLETO;
  // Dos franjas, una de mañana y otra de tarde (8-12 y 13-18), es jornada
  // completa aunque estén capturadas por separado: es justo como se ve el
  // horario real de la operación.
  if (turnos.has(MATUTINO) && turnos.has(VESPERTINO)) return COMPLETO;
  return turnos.has(MATUTINO) ? MATUTINO : VESPERTINO;
}

// ¿Esta vendedora cubre este turno hoy?
function cubreTurno(turnoDeLaPersona, turno) {
  if (!turnoDeLaPersona) return false;
  return turnoDeLaPersona === COMPLETO || turnoDeLaPersona === turno;
}

// El turno al que pertenece un instante: para saber en cuál cae una
// rellamada pactada a las 5 de la tarde.
function turnoDeHora(fecha) {
  const { minuto } = momentoLocal(fecha);
  return minuto < CORTE_MINUTO ? MATUTINO : VESPERTINO;
}

// El turno que corre AHORA, que es el que el botón "Ejecutar asignación"
// va a repartir.
function turnoActual(fecha = new Date()) {
  return turnoDeHora(fecha);
}

// Clasifica a un conjunto de vendedoras por turno, resolviendo sus
// horarios de una sola vez.
//
// `conectadas` son las que tienen sesión viva. El documento pide
// detectarlas y asumir "por descarte" que las demás son del vespertino;
// aquí eso no hace falta adivinarlo, porque el horario lo dice. La
// conexión se usa para otra cosa: avisar si alguien del turno en curso no
// ha entrado, que es un problema real de operación y no un dato que haya
// que inventar.
async function clasificarVendedoras(prisma, tenantId, fecha = new Date()) {
  const vendedoras = await prisma.user.findMany({
    where: { rol: "VENDEDOR", activo: true, tenantId },
    select: { id: true, nombre: true },
    orderBy: { nombre: "asc" },
  });

  const sesiones = await prisma.sesion.findMany({
    where: { tenantId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { userId: true },
  });
  const conectadas = new Set(sesiones.map((s) => s.userId));

  const out = [];
  for (const v of vendedoras) {
    const horarios = await horariosDe(v.id, tenantId);
    const turno = turnoDelDia(horarios, fecha);
    out.push({
      id: v.id,
      nombre: v.nombre,
      turno,
      conectada: conectadas.has(v.id),
      // Si está dentro de su horario EN ESTE MOMENTO. Distinto de "cubre
      // el turno": a las 12:30 nadie está dentro, y aun así el reparto de
      // la tarde tiene destinatarias.
      enHorario: evaluarTurno(horarios, fecha).dentro,
      sinHorario: horarios.length === 0,
    });
  }
  return out;
}

module.exports = {
  MATUTINO, VESPERTINO, COMPLETO, CORTE_MINUTO,
  turnoDeFranja, turnoDelDia, cubreTurno, turnoDeHora, turnoActual,
  clasificarVendedoras,
};
