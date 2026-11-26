// La asignación de cada día, en un solo lugar.
//
// Regla de operación:
//
//   antes de las 8        los leads esperan en la cola
//   8:00 en adelante      la coordinadora pulsa «Ejecutar asignación» UNA
//                         vez: se reparte la cola completa
//   después del clic      cada lead que entra se asigna solo, hasta las 18
//   durante el día        los que regresan a la cola al terminar su espera
//                         (o entraron cuando no había nadie conectada) se
//                         asignan solos cada 2 minutos
//                         (ver src/jobs/asignarCola.js)
//   desde las 18          los leads esperan en la cola al día siguiente
//   12 a.m.               todo lo abierto vuelve a la cola
//                         (ver src/jobs/desasignarMedianoche.js)
//
// El clic del día se guarda en un AppSetting con la fecha: al cambiar el
// día la marca deja de valer sola, sin que nadie tenga que borrarla.
//
// A quién se le asigna un lead que entra: a una vendedora con la
// aplicación abierta AHORA y dentro de su horario, o a una de las
// coordinadoras que se sumaron al reparto de la mañana (si está
// conectada), la que menos leads abiertos tenga. Si no hay nadie así, el
// lead se queda en la cola: dárselo a quien no está es enfriarlo.
const prisma = require("./prisma");
const { getParametros } = require("./parametros");
const { diaLocal, horaLocal } = require("./fechasLocales");
const { clasificarVendedoras } = require("./turnos");
const { usuariosConectados } = require("./eventos");
const { LEAD_STATUSES_ABIERTOS } = require("./leadStatus");

const CLAVE = "repartoDelDia";

async function leerMarca(tenantId) {
  const fila = await prisma.appSetting.findFirst({ where: { tenantId, key: CLAVE } });
  if (!fila) return { fila: null, valor: null };
  try {
    return { fila, valor: JSON.parse(fila.value) };
  } catch {
    return { fila, valor: null };
  }
}

// Lo que la pantalla y las reglas necesitan saber del día.
async function estadoDelDia(tenantId, ahora = new Date()) {
  const params = await getParametros(tenantId);
  const dia = diaLocal(ahora);
  const hora = horaLocal(ahora);
  const { valor } = await leerMarca(tenantId);
  const ejecutado = valor?.dia === dia ? valor : null;
  return {
    activo: params.asignacionAutomatica === true,
    dia,
    desde: params.asignacionAutoDesde,
    hasta: params.asignacionAutoHasta,
    enVentana: hora >= params.asignacionAutoDesde && hora < params.asignacionAutoHasta,
    // null = todavía no se pulsa hoy.
    ejecutado,
  };
}

// Por qué no se puede ejecutar ahora, o null si se puede.
function bloqueoParaEjecutar(estado) {
  if (!estado.activo) return "El reparto automático está apagado en Configuración";
  if (estado.ejecutado) {
    const hora = new Date(estado.ejecutado.at).toLocaleTimeString("es-MX", {
      hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City",
    });
    return `La asignación de hoy ya se ejecutó a las ${hora}${estado.ejecutado.porNombre ? ` (${estado.ejecutado.porNombre})` : ""}. Los leads nuevos se asignan solos hasta las ${estado.hasta}:00.`;
  }
  if (!estado.enVentana) {
    return `La asignación se ejecuta entre las ${estado.desde}:00 y las ${estado.hasta}:00.`;
  }
  return null;
}

async function registrarEjecucion(tenantId, { userId, nombre, coordinadoraIds }, ahora = new Date()) {
  const valor = JSON.stringify({
    dia: diaLocal(ahora),
    at: ahora.toISOString(),
    porId: userId,
    porNombre: nombre || null,
    coordinadoraIds: coordinadoraIds || [],
  });
  const { fila } = await leerMarca(tenantId);
  if (fila) await prisma.appSetting.update({ where: { id: fila.id }, data: { value: valor } });
  else await prisma.appSetting.create({ data: { tenantId, key: CLAVE, value: valor } });
}

// Quiénes pueden recibir leads en este momento y cuánto lleva cada una,
// o null si ahora no se asigna nada solo (todavía no se pulsa el botón
// hoy, o fuera de horario). Se calcula una vez y se reparte en memoria:
// para una tanda de leads, recalcularlo por lead serían decenas de
// consultas por cada uno.
async function candidatasDelMomento(tenantId, ahora = new Date()) {
  const estado = await estadoDelDia(tenantId, ahora);
  if (!estado.activo || !estado.ejecutado || !estado.enVentana) return null;

  const equipo = await clasificarVendedoras(prisma, tenantId, ahora);
  const conectadas = usuariosConectados(tenantId);
  // Sin horario capturado cuenta como en horario (ver planificarReparto).
  const candidatas = equipo
    .filter((v) => v.conectada && (v.enHorario || v.sinHorario))
    .map((v) => ({ id: v.id, nombre: v.nombre }));

  const coordIds = (estado.ejecutado.coordinadoraIds || []).filter((id) => conectadas.has(id));
  if (coordIds.length > 0) {
    const coords = await prisma.user.findMany({
      where: { id: { in: coordIds }, tenantId, rol: "COORDINADOR", activo: true },
      select: { id: true, nombre: true },
    });
    candidatas.push(...coords);
  }

  const cargas = candidatas.length
    ? await prisma.lead.groupBy({
        by: ["vendedorId"],
        where: { tenantId, status: { in: LEAD_STATUSES_ABIERTOS }, vendedorId: { in: candidatas.map((c) => c.id) } },
        _count: { _all: true },
      })
    : [];
  return { candidatas, carga: new Map(cargas.map((c) => [c.vendedorId, c._count._all])) };
}

// La que menos lleva abierto, evitando a quien se indique si hay otra.
// Suma el lead a su carga para que el siguiente de la tanda vaya parejo.
// El desempate por id hace el reparto reproducible y, entre iguales, rota.
function elegir({ candidatas, carga }, evitar = []) {
  if (candidatas.length === 0) return null;
  const orden = [...candidatas].sort((a, b) => (carga.get(a.id) ?? 0) - (carga.get(b.id) ?? 0) || a.id - b.id);
  const elegida = orden.find((c) => !evitar.includes(c.id)) || orden[0];
  carga.set(elegida.id, (carga.get(elegida.id) ?? 0) + 1);
  return elegida;
}

// A quién se le asigna un lead que entra AHORA, o null si se queda en la
// cola. Si no hay nadie conectada y en horario también es null: dárselo a
// quien no está es enfriarlo.
async function destinatariaParaLeadNuevo(tenantId, ahora = new Date()) {
  const momento = await candidatasDelMomento(tenantId, ahora);
  return momento ? elegir(momento) : null;
}

module.exports = { estadoDelDia, bloqueoParaEjecutar, registrarEjecucion, destinatariaParaLeadNuevo, candidatasDelMomento, elegir };
