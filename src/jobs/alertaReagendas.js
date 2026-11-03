// Avisa a la coordinadora cuando llega la hora de una re-llamada.
//
// El protocolo pide que la reagenda se reasigne "con alerta programada":
// el cliente pidio que le llamaran a una hora concreta, y una reagenda que
// nadie mira a tiempo es una promesa rota. La cola ya los muestra, pero
// nadie esta mirando la cola a las 11:40 de un martes.
//
// El aviso va a las coordinadoras del espacio, que son quienes reparten.
// Lleva la vendedora sugerida -- la que atendio la llamada donde se pidio
// la reagenda -- para que reasignar sea un clic y no una investigacion.
const prisma = require("../lib/prisma");
const { crearAvisos } = require("../lib/avisos");
const { emitir } = require("../lib/eventos");

// Cada cinco minutos: la reagenda tiene hora, y avisar media hora tarde
// es casi lo mismo que no avisar.
const INTERVAL_MS = 5 * 60 * 1000;

// Cuanto antes de la hora se avisa, para que de tiempo a repartirla.
const ANTICIPACION_MIN = 10;

async function avisarReagendasQueVencen() {
  const hasta = new Date(Date.now() + ANTICIPACION_MIN * 60000);

  const pendientes = await prisma.lead.findMany({
    where: {
      status: "REAGENDADO",
      fechaReagenda: { not: null, lte: hasta },
      // Solo las que nadie ha avisado todavia.
      reagendaAvisadaAt: null,
      // Si ya tiene vendedora, alguien la va a atender: el aviso es para
      // las que siguen esperando en la cola.
      vendedorId: null,
    },
    select: {
      id: true, nombre: true, tenantId: true, fechaReagenda: true,
      reagendaVendedorSugerido: { select: { nombre: true } },
    },
    take: 200,
  });
  if (pendientes.length === 0) return [];

  // Un aviso por espacio, a todas sus coordinadoras.
  const porTenant = new Map();
  for (const lead of pendientes) {
    if (!porTenant.has(lead.tenantId)) porTenant.set(lead.tenantId, []);
    porTenant.get(lead.tenantId).push(lead);
  }

  const resumen = [];

  for (const [tenantId, leads] of porTenant) {
    const coordinadoras = await prisma.user.findMany({
      where: { tenantId, rol: "COORDINADOR", activo: true },
      select: { id: true },
    });
    if (coordinadoras.length > 0) {
      for (const lead of leads) {
        const hora = lead.fechaReagenda.toLocaleTimeString("es-MX", {
          hour: "2-digit", minute: "2-digit",
        });
        const sugerida = lead.reagendaVendedorSugerido?.nombre;
        await crearAvisos(
          coordinadoras.map((c) => ({
            userId: c.id,
            tenantId,
            tipo: "lead.reagenda",
            categoria: "ALERTA",
            titulo: `Re-llamada de ${lead.nombre} a las ${hora}`,
            mensaje: sugerida
              ? `El cliente pidió esta hora. La atendió ${sugerida}: reasignársela a ella tiene prioridad.`
              : "El cliente pidió esta hora. Asígnala para que no se pase.",
            enlace: "/coordinador/leads",
          }))
        );
      }
    }

    await prisma.lead.updateMany({
      where: { id: { in: leads.map((l) => l.id) } },
      data: { reagendaAvisadaAt: new Date() },
    });

    emitir(tenantId, "reagendas.por_vencer", { total: leads.length });
    resumen.push({ tenantId, avisadas: leads.length });
  }

  return resumen;
}

function startAlertaReagendasJob() {
  const tick = async () => {
    try {
      const r = await avisarReagendasQueVencen();
      for (const { tenantId, avisadas } of r) {
        console.log(`alerta de reagendas: ${avisadas} por vencer (tenant ${tenantId})`);
      }
    } catch (err) {
      console.error("fallo la alerta de reagendas", err);
    }
  };

  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 2 * 60 * 1000);
}

module.exports = { startAlertaReagendasJob, avisarReagendasQueVencen };
