// Cierra los leads que agotaron sus 72 horas en cola sin que el cliente
// contestara nunca.
//
// El protocolo descarta en el momento en que una llamada falla pasado el
// plazo, pero eso solo ocurre si alguien vuelve a marcar. Un lead que se
// quedo en la cola sin que nadie lo tomara seguiria ahi para siempre: este
// tick es el que cumple la parte de "tras lo cual debe descartarse como
// trash" aunque nadie lo haya vuelto a llamar.
//
// Corre cada hora y no cada dia: el plazo se mide en horas, y esperar al
// dia siguiente dejaria leads muertos ocupando la cola media jornada.
const prisma = require("../lib/prisma");
const { getParametros } = require("../lib/parametros");
const { descartarPorPlazo, DESENLACES } = require("../lib/protocoloLeads");
const { LEAD_STATUSES_ABIERTOS } = require("../lib/leadStatus");
const { emitir } = require("../lib/eventos");

const INTERVAL_MS = 60 * 60 * 1000;

// Tope por empresa y corrida. Si esto se activa sobre meses de leads
// olvidados, se van cerrando por tandas en vez de en un golpe.
const MAX_POR_CORRIDA = 500;

async function cerrarVencidos() {
  const conAbiertos = await prisma.lead.groupBy({
    by: ["tenantId"],
    where: { status: { in: LEAD_STATUSES_ABIERTOS }, primeraLlamadaAt: { not: null } },
    _count: true,
  });

  const resumen = [];

  for (const { tenantId } of conAbiertos) {
    const params = await getParametros(tenantId);
    if (!params.reintentoAutomatico) continue;

    const limite = new Date(Date.now() - params.horasParaTrash * 3600000);

    const vencidos = await prisma.lead.findMany({
      where: {
        tenantId,
        status: { in: LEAD_STATUSES_ABIERTOS },
        // El plazo corre desde la reactivacion si el lead volvio a la cola;
        // si no, desde su primera llamada.
        OR: [
          { reintentosDesde: { not: null, lt: limite } },
          { reintentosDesde: null, primeraLlamadaAt: { not: null, lt: limite } },
        ],
      },
      select: { id: true, ultimoDesenlace: true },
      take: MAX_POR_CORRIDA,
    });
    if (vencidos.length === 0) continue;

    // Un lead que llego a contestar alguna vez no es "no contesto": la
    // conversacion existio y el desenlace lo decide quien lo atienda, no
    // el reloj.
    const contestados = await prisma.llamada.groupBy({
      by: ["leadId"],
      where: { leadId: { in: vencidos.map((l) => l.id) }, contestada: true },
    });
    const yaHablaron = new Set(contestados.map((c) => c.leadId));

    let cerrados = 0;
    for (const lead of vencidos) {
      if (yaHablaron.has(lead.id)) continue;
      const desenlace = DESENLACES[lead.ultimoDesenlace] ?? DESENLACES.NO_CONTESTA;
      try {
        await descartarPorPlazo(lead.id, desenlace);
        cerrados += 1;
      } catch (err) {
        console.error("no se pudo cerrar por plazo el lead", lead.id, err);
      }
    }

    if (cerrados > 0) {
      emitir(tenantId, "leads.cerrados_por_plazo", { total: cerrados });
      resumen.push({ tenantId, cerrados });
    }
  }

  return resumen;
}

function startCierrePorPlazoJob() {
  const tick = async () => {
    try {
      const r = await cerrarVencidos();
      for (const { tenantId, cerrados } of r) {
        console.log(`cierre por plazo: ${cerrados} leads descartados (tenant ${tenantId})`);
      }
    } catch (err) {
      console.error("fallo el cierre por plazo", err);
    }
  };

  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 4 * 60 * 1000);
}

module.exports = { startCierrePorPlazoJob, cerrarVencidos };
