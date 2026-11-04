// Avisa a la coordinadora de los leads que se quedaron atrás.
//
// El protocolo pide dos alertas que la pantalla sola no puede dar, porque
// nadie está mirando la cola a las 13:15 de un martes:
//
//   reintento atrasado      el lead ya cumplió su espera, pasó su ventana
//                           de reparto y 15 minutos más, y nadie lo asignó.
//                           Ejemplo del documento: no contesta a las 11:00
//                           -> disponible 13:00 -> alerta 13:15.
//   seguimiento incompleto  se vencieron las 72 horas sin los intentos que
//                           tocaban. El lead NO se cerró -- cerrarlo sería
//                           descartar una oportunidad que nadie trabajó --
//                           así que alguien tiene que enterarse de que sigue
//                           ahí, abierto y atrasado.
//
// Ninguna de las dos bloquea el lead: el documento es explícito en que la
// alerta de atraso no debe impedir que se asigne después. Bloquearlo lo
// dejaría inalcanzable justo cuando más urge.
//
// El aviso se manda UNA vez por lead y por motivo. `reagendaAvisadaAt` ya
// cumple ese papel para las rellamadas; aquí el candado es la clave del
// aviso (ver model Notificacion), que es única por usuario: si el aviso ya
// existe no se crea otro, y la coordinadora no acaba con cuarenta líneas
// del mismo lead cada cinco minutos.
const prisma = require("../lib/prisma");
const { crearAvisos } = require("../lib/avisos");
const { emitir } = require("../lib/eventos");
const { getParametros } = require("../lib/parametros");
const { LEAD_STATUSES_ABIERTOS } = require("../lib/leadStatus");

// Cada cinco minutos. La ventana del protocolo es de 15: avisar cada media
// hora llegaría sistemáticamente tarde.
const INTERVAL_MS = 5 * 60 * 1000;

// Tope por corrida y por empresa. Si esto se enciende sobre una cola que
// lleva días sin atenderse, los avisos salen por tandas en vez de llenar la
// campana de golpe con doscientas líneas que nadie va a leer.
const MAX_POR_CORRIDA = 40;

async function avisarAtrasos() {
  const resumen = [];

  const tenants = await prisma.lead.groupBy({
    by: ["tenantId"],
    where: { vendedorId: null, status: { in: LEAD_STATUSES_ABIERTOS } },
    _count: true,
  });

  for (const { tenantId } of tenants) {
    const params = await getParametros(tenantId);
    const ahora = new Date();

    const coordinadoras = await prisma.user.findMany({
      where: { tenantId, rol: "COORDINADOR", activo: true },
      select: { id: true },
    });
    // Sin coordinadoras no hay a quién avisar. Los leads siguen marcados en
    // la cola; esto sólo es el empujón.
    if (coordinadoras.length === 0) continue;

    // El corte del documento: la ventana de reparto más los minutos de
    // gracia. Antes de eso el lead está atrasado pero todavía se puede
    // atender con calma, y avisar ahí convertiría en urgencia algo que no
    // lo es.
    const corte = new Date(ahora.getTime() - params.alertaAtrasoMin * 60000);

    const atrasados = await prisma.lead.findMany({
      where: {
        tenantId,
        vendedorId: null,
        status: { in: LEAD_STATUSES_ABIERTOS },
        OR: [
          { disponibleHasta: { not: null, lt: corte } },
          { seguimientoIncompleto: true },
        ],
      },
      select: {
        id: true,
        nombre: true,
        folioPS: true,
        seguimientoIncompleto: true,
        intentosEsperados: true,
        intentosRealizados: true,
        disponibleHasta: true,
        ultimoDesenlace: true,
      },
      orderBy: { disponibleHasta: "asc" },
      take: MAX_POR_CORRIDA,
    });
    if (atrasados.length === 0) continue;

    for (const lead of atrasados) {
      const incompleto = lead.seguimientoIncompleto;
      const ref = lead.folioPS ? `${lead.nombre} (${lead.folioPS})` : lead.nombre;

      await crearAvisos(
        coordinadoras.map((c) => ({
          userId: c.id,
          tenantId,
          tipo: incompleto ? "lead.seguimiento_incompleto" : "lead.reintento_atrasado",
          categoria: "ALERTA",
          titulo: incompleto
            ? `Seguimiento incompleto: ${ref}`
            : `Reintento atrasado: ${ref}`,
          mensaje: incompleto
            ? `Se vencieron las 72 horas sin los intentos que tocaban${
                lead.intentosRealizados != null && lead.intentosEsperados != null
                  ? ` (${lead.intentosRealizados} de ${lead.intentosEsperados})`
                  : ""
              }. El lead NO se cerró: sigue disponible y necesita atención.`
            : "Ya pasó su ventana de reparto y nadie lo ha asignado. Se sigue pudiendo asignar.",
          enlace: "/coordinador/leads",
          // Una sola alerta por lead y por motivo. Sin esta clave, el tick
          // de cada cinco minutos repetiría el mismo aviso indefinidamente.
          clave: `${incompleto ? "atraso-72h" : "atraso-ventana"}:${lead.id}`,
        }))
      );
    }

    emitir(tenantId, "leads.atrasados", { total: atrasados.length });
    resumen.push({ tenantId, avisados: atrasados.length });
  }

  return resumen;
}

function startAlertaAtrasosJob() {
  const tick = async () => {
    try {
      for (const { tenantId, avisados } of await avisarAtrasos()) {
        console.log(`alerta de atrasos: ${avisados} leads (tenant ${tenantId})`);
      }
    } catch (err) {
      console.error("falló la alerta de atrasos", err);
    }
  };

  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 3 * 60 * 1000);
}

module.exports = { startAlertaAtrasosJob, avisarAtrasos };
