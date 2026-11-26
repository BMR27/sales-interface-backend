// Durante el día, lo que queda en la cola se asigna solo.
//
// Después del clic de la mañana (ver src/lib/asignacionDelDia.js) los
// leads nuevos se asignan al entrar, pero la cola se sigue llenando por
// otros lados: un lead que no contestó vuelve con una espera de 2 a 4
// horas, y uno que entró cuando no había nadie conectada se quedó ahí.
// Como el botón se usa una sola vez al día, sin esto esos leads esperarían
// a que alguien los asignara a mano.
//
// Cada 2 minutos, y sólo con la asignación del día ejecutada y dentro del
// horario: toma lo repartible (sin vendedora, vivo y con la espera
// cumplida) y lo reparte a quien esté conectada y en horario, la que menos
// lleve. Si el lead ya rebotó con alguien, se prefiere a otra: un intento
// con una voz nueva, no la misma que no logró contactarlo.
//
// Las rellamadas con hora pactada NO entran: tienen su propia regla (se
// devuelven a quien las generó en el reparto de la mañana y la
// coordinadora recibe un aviso antes de la hora).
const prisma = require("../lib/prisma");
const { dondeRepartible } = require("../lib/colaLeads");
const { candidatasDelMomento, elegir } = require("../lib/asignacionDelDia");
const { registrarAsignacion } = require("../lib/cicloLead");
const { crearAviso } = require("../lib/avisos");
const { emitir } = require("../lib/eventos");

const INTERVAL_MS = 2 * 60 * 1000;
// Un tope por vuelta: si la cola trae 200, se reparten en varias vueltas y
// no en una transacción eterna.
const TOPE = 60;

async function asignarColaDelEspacio(tenantId, ahora = new Date()) {
  const momento = await candidatasDelMomento(tenantId, ahora);
  if (!momento || momento.candidatas.length === 0) return 0;

  const leads = await prisma.lead.findMany({
    where: {
      ...dondeRepartible(tenantId),
      NOT: { status: "REAGENDADO", fechaReagenda: { not: null } },
    },
    orderBy: [{ disponibleDesde: "asc" }, { createdAt: "asc" }],
    take: TOPE,
    select: {
      id: true, nombre: true, status: true, vendedorId: true, disponibleDesde: true, disponibleHasta: true,
      fechaReagenda: true, createdAt: true,
      llamadas: { orderBy: { fecha: "desc" }, take: 1, select: { vendedorId: true } },
    },
  });

  const porPersona = new Map();
  for (const l of leads) {
    const anterior = l.llamadas[0]?.vendedorId;
    const elegida = elegir(momento, anterior ? [anterior] : []);
    if (!elegida) break;
    const ok = await prisma.$transaction(async (tx) => {
      // updateMany con vendedorId null: si alguien lo asignó a mano en
      // este instante, no se le quita.
      const { count } = await tx.lead.updateMany({
        where: { id: l.id, tenantId, vendedorId: null },
        data: { vendedorId: elegida.id, asignadoAt: ahora, disponibleDesde: null, disponibleHasta: null },
      });
      if (count === 0) return false;
      await registrarAsignacion(tx, {
        leadId: l.id,
        tenantId,
        actor: null,
        anterior: null,
        nuevo: { id: elegida.id, nombre: elegida.nombre },
        evento: "asignada",
        motivo: l.llamadas.length
          ? "Asignación automática: terminó su espera y vuelve a trabajarse"
          : "Asignación automática: estaba esperando en la cola",
        automatico: true,
        leadAntes: l,
        leadDespues: { ...l, vendedorId: elegida.id, disponibleDesde: null, disponibleHasta: null },
      });
      return true;
    });
    if (ok) porPersona.set(elegida.id, [...(porPersona.get(elegida.id) || []), l.nombre]);
  }

  for (const [userId, nombres] of porPersona) {
    crearAviso({
      userId,
      tenantId,
      tipo: "lead.asignado",
      categoria: "INFO",
      titulo: nombres.length === 1 ? "Nuevo lead asignado" : `${nombres.length} leads nuevos en tu cola`,
      mensaje: nombres.length === 1
        ? `${nombres[0]} está en tu cola, asignado automáticamente.`
        : `Se te asignaron ${nombres.length} leads automáticamente.`,
      enlace: "/leads",
    });
  }
  const total = [...porPersona.values()].reduce((a, n) => a + n.length, 0);
  if (total > 0) emitir(tenantId, "leads.asignados", { total, automatico: true });
  return total;
}

async function asignarColas() {
  try {
    const tenants = await prisma.tenant.findMany({ where: { status: "ACTIVO" }, select: { id: true } });
    for (const t of tenants) {
      try {
        const n = await asignarColaDelEspacio(t.id);
        if (n > 0) console.log(`asignación de la cola: ${n} leads en el espacio ${t.id}`);
      } catch (err) {
        console.error("asignación de la cola: fallo en el espacio", t.id, err);
      }
    }
  } catch (err) {
    console.error("asignación de la cola: no se pudo listar los espacios", err);
  }
}

function startAsignarColaJob() {
  setTimeout(() => {
    asignarColas();
    setInterval(asignarColas, INTERVAL_MS);
  }, 60 * 1000);
}

module.exports = { startAsignarColaJob, asignarColaDelEspacio };
