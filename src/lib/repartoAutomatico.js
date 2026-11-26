// El reparto automático de leads entre las vendedoras del turno.
//
// Sustituye al reparto a mano cuando el administrador lo enciende. La
// coordinadora aprieta "Ejecutar asignación" al empezar el turno y el
// sistema reparte; con la opción apagada, todo sigue como hasta ahora.
//
// Las tres poblaciones se reparten por separado porque no valen lo mismo:
//
//   nuevos       nadie los ha llamado. Es lo más valioso y lo que hay que
//                repartir parejo.
//   trabajados   ya tienen intentos. Se reparten intercalando los muy
//                trabajados con los poco trabajados, para que a nadie le
//                toque solo el fondo del barril.
//   rellamadas   tienen hora pactada con un cliente. Mandan sobre todo lo
//                demás y siguen su propia regla.
//
// Lo que se RESERVA para el vespertino: repartir todos los nuevos en la
// mañana dejaría a la tarde con las sobras, y el documento pide
// explícitamente que no pase. Se reparte la parte proporcional a la gente
// que cubre el turno en curso y el resto espera. Con 3 matutinas y 2
// vespertinas, la mañana se lleva 3/5 y la tarde 2/5.
//
// Lo que este módulo NO hace: inventar prioridades. El orden dentro de
// cada población es el de siempre -- primero el que lleva más esperando
// -- y el candado del protocolo (`disponibleDesde`) se respeta igual que
// en el reparto manual.
const { cubreTurno, turnoActual, turnoDeHora, clasificarVendedoras } = require("./turnos");
const { filtroDisponible } = require("./protocoloLeads");
const { LEAD_STATUSES_ABIERTOS } = require("./leadStatus");
const { usuariosConectados } = require("./eventos");

// Las coordinadoras que se pueden sumar al reparto: activas y del
// espacio. Las dadas de baja no aparecen ni se aceptan aunque alguien
// mande su id.
async function coordinadorasDelEspacio(prisma, tenantId) {
  const conectadas = usuariosConectados(tenantId);
  const lista = await prisma.user.findMany({
    where: { tenantId, rol: "COORDINADOR", activo: true },
    select: { id: true, nombre: true, rol: true },
    orderBy: { nombre: "asc" },
  });
  return lista.map((c) => ({ ...c, conectada: conectadas.has(c.id) }));
}

// Reparte una lista entre varias personas, de una en una y por turnos.
//
// Se parte de la carga que cada una YA tiene para que el reparto iguale
// en vez de repartir a ciegas: quien llega con 12 leads recibe menos que
// quien llega con 3. Sin esto, "equitativo" significaría "la misma
// cantidad hoy", que es justo lo que desnivela.
function repartirEquitativo(items, personas, cargaInicial) {
  const asignaciones = [];
  if (personas.length === 0 || items.length === 0) return asignaciones;

  const carga = new Map(personas.map((p) => [p.id, cargaInicial.get(p.id) ?? 0]));

  for (const item of items) {
    // La que menos lleva. El desempate por id mantiene el reparto
    // reproducible: dos corridas con los mismos datos dan lo mismo.
    let elegida = personas[0];
    for (const p of personas) {
      const actual = carga.get(p.id) ?? 0;
      const mejor = carga.get(elegida.id) ?? 0;
      if (actual < mejor || (actual === mejor && p.id < elegida.id)) elegida = p;
    }
    asignaciones.push({ leadId: item.id, vendedorId: elegida.id, vendedora: elegida.nombre });
    carga.set(elegida.id, (carga.get(elegida.id) ?? 0) + 1);
  }
  return asignaciones;
}

// Intercala los más trabajados con los menos trabajados.
//
// Si se repartieran en orden, a las primeras de la lista les tocarían
// todos los leads con 15 intentos y a las últimas los de 1. Alternando
// desde los dos extremos, todas reciben de los dos tipos.
function intercalarPorIntentos(leads) {
  const orden = [...leads].sort((a, b) => (b._count?.llamadas ?? 0) - (a._count?.llamadas ?? 0));
  const salida = [];
  let i = 0;
  let j = orden.length - 1;
  while (i <= j) {
    salida.push(orden[i]);
    if (i !== j) salida.push(orden[j]);
    i += 1;
    j -= 1;
  }
  return salida;
}

// Arma el plan de reparto SIN aplicarlo.
//
// Separar planificar de ejecutar permite enseñarle a la coordinadora qué
// va a pasar antes de que pase, que en un reparto de 100 leads es la
// diferencia entre una herramienta y una ruleta.
//
// `coordinadoraIds`: las coordinadoras que la persona que reparte marcó
// para recibir leads también. Entran como una vendedora más del turno
// -- no tienen horario de vendedora -- pero igual que ellas, sólo si
// están conectadas.
async function planificarReparto(prisma, tenantId, fecha = new Date(), { coordinadoraIds = [] } = {}) {
  const turno = turnoActual(fecha);

  const equipo = await clasificarVendedoras(prisma, tenantId, fecha);
  const enTurno = equipo.filter((v) => cubreTurno(v.turno, turno));
  // Un lead caliente no se le da a quien no está: con la aplicación
  // cerrada no lo va a llamar, y se enfría en su lista mientras otra
  // conectada podría estar marcándole. Sigue en turno, pero no recibe.
  const desconectadas = enTurno.filter((v) => !v.conectada);
  const vendedorasDelTurno = enTurno.filter((v) => v.conectada);

  const coordinadoras = await coordinadorasDelEspacio(prisma, tenantId);
  const pedidas = new Set(coordinadoraIds.map(Number));
  const coordinadorasElegidas = coordinadoras.filter((c) => pedidas.has(c.id));
  const coordinadorasQueReciben = coordinadorasElegidas.filter((c) => c.conectada);

  // Quienes reciben leads en este reparto.
  const delTurno = [...vendedorasDelTurno, ...coordinadorasQueReciben];

  if (delTurno.length === 0) {
    return {
      turno,
      error: enTurno.length > 0
        ? "Las vendedoras del turno en curso no están conectadas. Nadie recibiría los leads."
        : "No hay vendedoras con horario en el turno en curso",
      equipo,
      coordinadoras,
      desconectadas,
      asignaciones: [],
      reservados: 0,
    };
  }

  // Quienes pueden recibir una rellamada que ellas generaron: cualquier
  // vendedora activa (conectada o no) y las coordinadoras elegidas. La
  // rellamada es un compromiso de esa persona con el cliente.
  const puedenRecibirSuRellamada = new Map(
    [...equipo, ...coordinadorasElegidas].map((p) => [p.id, p])
  );

  // La carga viva de cada una: lo que ya tiene abierto y sin cerrar.
  const cargas = await prisma.lead.groupBy({
    by: ["vendedorId"],
    where: { tenantId, status: { in: LEAD_STATUSES_ABIERTOS }, vendedorId: { not: null } },
    _count: { _all: true },
  });
  const cargaInicial = new Map(cargas.map((c) => [c.vendedorId, c._count._all]));

  // Lo repartible: sin vendedora, vivo y con la espera del protocolo
  // cumplida. Son las mismas condiciones del reparto manual.
  const repartibles = await prisma.lead.findMany({
    where: {
      tenantId,
      vendedorId: null,
      status: { in: LEAD_STATUSES_ABIERTOS },
      ...filtroDisponible(),
    },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { llamadas: true } } },
  });

  const rellamadas = repartibles.filter((l) => l.status === "REAGENDADO" && l.fechaReagenda);
  const resto = repartibles.filter((l) => !(l.status === "REAGENDADO" && l.fechaReagenda));
  const nuevos = resto.filter((l) => (l._count?.llamadas ?? 0) === 0);
  const trabajados = resto.filter((l) => (l._count?.llamadas ?? 0) > 0);

  const asignaciones = [];

  // --- 1. Rellamadas ---
  //
  // Primero porque hay un cliente esperando a una hora concreta.
  //
  //   la pactó alguien que está en este turno  -> se le devuelve a ella
  //   está pactada para OTRO turno             -> se retiene, no se reparte
  //   es de este turno pero ella no está       -> a otra de este turno
  const rellamadasDeOtroTurno = [];
  const rellamadasAReparir = [];

  for (const l of rellamadas) {
    const turnoDeLaCita = turnoDeHora(l.fechaReagenda);
    if (turnoDeLaCita !== turno) {
      // No es su momento: se queda para cuando entre ese turno.
      rellamadasDeOtroTurno.push(l);
      continue;
    }
    // Se respeta a quien la generó aunque esté desconectada en este
    // momento: el cliente espera SU llamada, a la hora que pactaron. Sólo
    // se reparte a otra si ya no está activa.
    const original = l.reagendaVendedorSugeridoId
      ? puedenRecibirSuRellamada.get(l.reagendaVendedorSugeridoId)
      : null;
    if (original) {
      asignaciones.push({
        leadId: l.id,
        vendedorId: original.id,
        vendedora: original.nombre,
        motivo: "Rellamada: se respeta a quien la generó",
      });
      cargaInicial.set(original.id, (cargaInicial.get(original.id) ?? 0) + 1);
    } else {
      rellamadasAReparir.push(l);
    }
  }

  for (const a of repartirEquitativo(rellamadasAReparir, delTurno, cargaInicial)) {
    asignaciones.push({ ...a, motivo: "Rellamada de este turno; quien la generó ya no está activa" });
    cargaInicial.set(a.vendedorId, (cargaInicial.get(a.vendedorId) ?? 0) + 1);
  }

  // --- 2. Nuevos ---
  //
  // Todos, sin reservar una parte para el otro turno: la asignación se
  // ejecuta una sola vez al día y lo que entra después se asigna solo a
  // quien esté conectada y en horario (ver src/lib/asignacionDelDia.js).
  // Reservar dejaría esos leads en la cola sin que nadie los repartiera.
  const nuevosAhora = nuevos;
  const reservados = 0;

  for (const a of repartirEquitativo(nuevosAhora, delTurno, cargaInicial)) {
    asignaciones.push({ ...a, motivo: "Lead nuevo" });
    cargaInicial.set(a.vendedorId, (cargaInicial.get(a.vendedorId) ?? 0) + 1);
  }

  // --- 3. Trabajados ---
  for (const a of repartirEquitativo(intercalarPorIntentos(trabajados), delTurno, cargaInicial)) {
    asignaciones.push({ ...a, motivo: "Reintento" });
    cargaInicial.set(a.vendedorId, (cargaInicial.get(a.vendedorId) ?? 0) + 1);
  }

  return {
    turno,
    equipo,
    enTurno: delTurno,
    // Para la pantalla: a quién se podía sumar y quién quedó fuera por no
    // estar conectada.
    coordinadoras,
    desconectadas,
    coordinadorasDesconectadas: coordinadorasElegidas.filter((c) => !c.conectada),
    asignaciones,
    resumen: {
      nuevos: nuevos.length,
      trabajados: trabajados.length,
      rellamadas: rellamadas.length,
      // Lo que NO se reparte ahora y por qué: sin esto, la coordinadora
      // ve "90 repartibles" y "60 asignados" y no sabe qué pasó con 30.
      reservadosParaElOtroTurno: reservados,
      rellamadasDeOtroTurno: rellamadasDeOtroTurno.length,
      aAsignar: asignaciones.length,
    },
  };
}

module.exports = { planificarReparto, repartirEquitativo, intercalarPorIntentos, coordinadorasDelEspacio };
