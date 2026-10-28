// Protocolo de reintento cuando el cliente no contesta.
//
// La regla de negocio: no se descarta un lead porque no contesto una vez.
// Vuelve a la fila, deja pasar un rato y se le insiste, hasta agotar los
// intentos. Solo entonces se da por perdido -- y ahi si cuenta como basura
// de la base, porque el proveedor cobro por un numero que nunca respondio.
//
// Lo que NO exige el protocolo: que lo retome la misma vendedora ni que
// sea el mismo dia. Puede tomarlo cualquiera, cuando le toque.
//
// La espera importa. Marcarle tres veces seguidas en cinco minutos no es
// insistir, es quemar al cliente, y ademas agota el protocolo sin haberle
// dado una oportunidad real. Por eso el lead vuelve a la cola pero con
// `disponibleDesde` en el futuro: esta en fila, no disponible todavia.
const prisma = require("./prisma");
const { getParametros } = require("./parametros");
const { LEAD_STATUSES_ABIERTOS } = require("./leadStatus");

// Se ejecuta al terminar una llamada que nadie contesto. Nunca lanza: va
// colgado del webhook de Twilio, y un fallo aqui no puede tumbar el aviso
// de fin de llamada ni dejar la llamada a medias.
async function aplicarProtocoloNoContesto({ leadId, tenantId }) {
  try {
    if (!leadId || !tenantId) return null;

    const params = await getParametros(tenantId);
    if (!params.reintentoAutomatico) return null;

    const lead = await prisma.lead.findFirst({
      where: { id: leadId, tenantId },
      select: { id: true, status: true, vendedorId: true },
    });
    // Un lead ya cerrado -- vendido o descartado -- no es trabajo de nadie.
    if (!lead || !LEAD_STATUSES_ABIERTOS.includes(lead.status)) return null;

    const [intentos, contestadas] = await Promise.all([
      prisma.llamada.count({ where: { leadId, tenantId } }),
      prisma.llamada.count({ where: { leadId, tenantId, contestada: true } }),
    ]);

    // Si alguna vez contesto, el numero servia y la conversacion existio:
    // este protocolo no aplica. Lo que siga lo decide quien lo atienda.
    if (contestadas > 0) return null;

    const umbral = params.calidadIntentosNoContesto;

    if (intentos >= umbral) {
      await prisma.lead.update({
        where: { id: leadId },
        data: {
          status: "DESCARTADO",
          motivoDescarte: "NO_CONTESTO",
          motivoDescarteNota: `Descarte automatico: ${intentos} intentos sin respuesta`,
          descartadoAt: new Date(),
          // Sin `descartadoPorId`: no lo descarto una persona, lo descarto
          // el protocolo. Atribuirselo a la ultima vendedora que marco
          // seria culparla de una regla que no decidio.
          disponibleDesde: null,
          requiereSupervision: false,
        },
      });
      return { accion: "descartado", intentos, umbral };
    }

    const esperaMs = params.reintentoEsperaMinutos * 60000;
    await prisma.lead.update({
      where: { id: leadId },
      data: {
        vendedorId: null,
        asignadoPorCoordinador: false,
        disponibleDesde: new Date(Date.now() + esperaMs),
        devueltoAt: new Date(),
        devueltoMotivo: `No contesto (intento ${intentos} de ${umbral})`,
        devueltoPorNombre: "Protocolo automatico",
      },
    });
    return { accion: "reencolado", intentos, umbral, esperaMinutos: params.reintentoEsperaMinutos };
  } catch (err) {
    console.error("no se pudo aplicar el protocolo de no contesto", leadId, err);
    return null;
  }
}

// Filtro de Prisma para "se puede repartir ahora": o nunca estuvo en
// espera, o la espera ya paso. Se usa en la cola del coordinador y en el
// reparto automatico, que si no entregarian leads que acaban de rebotar.
function filtroDisponible() {
  return {
    OR: [{ disponibleDesde: null }, { disponibleDesde: { lte: new Date() } }],
  };
}

module.exports = { aplicarProtocoloNoContesto, filtroDisponible };
