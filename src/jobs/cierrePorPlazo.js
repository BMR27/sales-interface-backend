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
const {
  cerrarPorProtocolo,
  evaluarSeguimiento,
  clasificarDesenlace,
  DESENLACES,
  PROTOCOLO_DESDE,
} = require("../lib/protocoloLeads");
const { horarioOperativo } = require("../lib/cicloLead");
const { LEAD_STATUSES_ABIERTOS } = require("../lib/leadStatus");
const { emitir } = require("../lib/eventos");

// El resultado que eligio la vendedora, traducido al cubo del protocolo.
// Es lo que permite medir el seguimiento con la espera correcta: quien
// rechazo la llamada debia esperar 3 horas, no 2.
const RESULTADO_A_DESENLACE = {
  NO_CONTESTA: "NO_CONTESTA",
  RECHAZA_LLAMADA: "RECHAZA",
  FUERA_DE_SERVICIO: "FUERA_DE_SERVICIO",
};

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
        // Solo los leads nacidos desde que el protocolo entro en vigor.
        // Sin este corte, el primer arranque encontraria semanas de leads
        // viejos pasados de las 72 horas y los cerraria en masa.
        createdAt: { gte: PROTOCOLO_DESDE },
        // El plazo corre desde la reactivacion si el lead volvio a la cola;
        // si no, desde su primera llamada.
        //
        // `primeraLlamadaAt: { not: null }` es la guarda que impide cerrar
        // un lead al que nunca se le marco: sin primera llamada las 72
        // horas no han arrancado, por viejo que sea el lead.
        OR: [
          { reintentosDesde: { not: null, lt: limite } },
          { reintentosDesde: null, primeraLlamadaAt: { not: null, lt: limite } },
        ],
        // Una rellamada que el cliente pidio y que todavia no llega protege
        // al lead: cerrarlo por el temporizador de reintentos seria
        // incumplir lo que se le prometio por telefono.
        NOT: { fechaReagenda: { gt: new Date() } },
      },
      select: {
        id: true,
        ultimoDesenlace: true,
        primeraLlamadaAt: true,
        reintentosDesde: true,
        seguimientoIncompleto: true,
      },
      take: MAX_POR_CORRIDA,
    });
    if (vencidos.length === 0) continue;

    const ids = vencidos.map((l) => l.id);

    // Las llamadas de todos los vencidos, de un golpe. Se necesitan
    // completas (no solo el conteo) porque la validacion de seguimiento
    // mira CUANDO fue cada intento y como termino, no cuantos hubo.
    const llamadas = await prisma.llamada.findMany({
      where: { leadId: { in: ids }, tenantId },
      select: { leadId: true, fecha: true, desenlace: true, resultado: true, contestada: true },
      orderBy: { fecha: "asc" },
    });

    const porLead = new Map();
    const yaHablaron = new Set();
    for (const ll of llamadas) {
      if (ll.contestada) yaHablaron.add(ll.leadId);
      if (!porLead.has(ll.leadId)) porLead.set(ll.leadId, []);
      porLead.get(ll.leadId).push(ll);
    }

    // Los turnos de la empresa: sin ellos no se puede saber si la llamada
    // que falto se debia a una hora en que no habia nadie trabajando.
    const horarios = await horarioOperativo(tenantId);

    let cerrados = 0;
    let atrasados = 0;

    for (const lead of vencidos) {
      // Un lead que llego a contestar alguna vez no es "no contesto": la
      // conversacion existio y el desenlace lo decide quien lo atienda, no
      // el reloj.
      if (yaHablaron.has(lead.id)) continue;

      const intentos = (porLead.get(lead.id) ?? []).map((ll) => ({
        fecha: ll.fecha,
        // El resultado que tipifico la vendedora manda sobre lo que dedujo
        // Twilio: ella estuvo en la llamada.
        desenlaceProtocolo:
          RESULTADO_A_DESENLACE[ll.resultado] ?? clasificarDesenlace(ll.desenlace).clave,
      }));

      const veredicto = evaluarSeguimiento({
        llamadas: intentos,
        params,
        horarios,
        // El plazo se evalua a su vencimiento, no a la hora en que corre
        // este tick: si el job estuvo caido tres dias, el lead no se vuelve
        // "mas incompleto" por eso.
        hasta: new Date(
          (lead.reintentosDesde ?? lead.primeraLlamadaAt).getTime() + params.horasParaTrash * 3600000
        ),
      });

      try {
        if (veredicto.completo) {
          // Se hicieron los intentos que tocaban y nunca contestaron: el
          // protocolo se agoto correctamente. NO es trash, es No concretado.
          const desenlace = DESENLACES[lead.ultimoDesenlace] ?? DESENLACES.NO_CONTESTA;
          await cerrarPorProtocolo(lead.id, desenlace, veredicto);
          cerrados += 1;
        } else if (!lead.seguimientoIncompleto) {
          // Se vencio el plazo pero faltaron intentos. NO se cierra: el
          // lead sigue vivo y disponible, marcado como atrasado para que la
          // coordinadora lo atienda con prioridad. Cerrarlo aqui seria
          // descartar una oportunidad que nadie trabajo, que es justo lo
          // que esta regla existe para impedir.
          await prisma.lead.update({
            where: { id: lead.id },
            data: {
              seguimientoIncompleto: true,
              seguimientoIncompletoAt: new Date(),
              intentosEsperados: veredicto.intentosEsperados,
              intentosRealizados: veredicto.intentosRealizados,
            },
          });
          atrasados += 1;
        }
      } catch (err) {
        console.error("no se pudo evaluar el plazo del lead", lead.id, err);
      }
    }

    if (cerrados > 0 || atrasados > 0) {
      emitir(tenantId, "leads.cerrados_por_plazo", { total: cerrados, atrasados });
      resumen.push({ tenantId, cerrados, atrasados });
    }
  }

  return resumen;
}

function startCierrePorPlazoJob() {
  const tick = async () => {
    try {
      const r = await cerrarVencidos();
      for (const { tenantId, cerrados, atrasados } of r) {
        console.log(
          `cierre por plazo (tenant ${tenantId}): ${cerrados} no concretados, ${atrasados} marcados como seguimiento incompleto`
        );
      }
    } catch (err) {
      console.error("fallo el cierre por plazo", err);
    }
  };

  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 4 * 60 * 1000);
}

module.exports = { startCierrePorPlazoJob, cerrarVencidos };
