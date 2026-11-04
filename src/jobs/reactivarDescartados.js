// Devuelve a la cola los leads descartados que ya cumplieron su plazo.
//
// La regla la enciende cada empresa en Configuración > Operación y nace
// apagada: reactivar descartados cambia la carga de trabajo del equipo y
// el porcentaje de calidad de la base, así que no debe pasar por default.
//
// Qué se reactiva y con qué campos lo decide src/lib/reactivacionLeads.js,
// el mismo que usa el botón del administrador. Si este tick escribiera sus
// propios campos, acabaría olvidando `reintentosDesde` y el protocolo
// volvería a descartar los leads en la primera llamada.
const prisma = require("../lib/prisma");
const { dondeReactivable, reactivar, reglaAutomatica } = require("../lib/reactivacionLeads");
const { LEAD_STATUSES_CERRADOS_SIN_VENTA } = require("../lib/leadStatus");

// El plazo se mide en días, así que una corrida diaria basta.
const INTERVAL_MS = 24 * 60 * 60 * 1000;

async function reactivarVencidos() {
  // Solo las empresas que tienen descartados: recorrer tenants vacíos es
  // leer parámetros para nada.
  const conDescartados = await prisma.lead.groupBy({
    by: ["tenantId"],
    // Los dos cierres sin venta. NO_CONCRETADO (se agoto el plazo sin que
    // nadie contestara) es justo el que la regla diaria existe para
    // reintentar semanas despues: "esa racha de horarios fue mala".
    where: { status: { in: LEAD_STATUSES_CERRADOS_SIN_VENTA } },
    _count: true,
  });

  const resumen = [];

  for (const { tenantId } of conDescartados) {
    const regla = await reglaAutomatica(tenantId);
    if (!regla.activa) continue;

    const antesDe = new Date(Date.now() - regla.dias * 24 * 60 * 60 * 1000);
    const candidatos = await prisma.lead.findMany({
      where: dondeReactivable(tenantId, { antesDe }),
      select: { id: true },
      // Los más viejos primero: son los que llevan más tiempo esperando.
      orderBy: { descartadoAt: "asc" },
      // El tope evita que al encender la regla por primera vez caigan
      // meses de descartes de golpe sobre la cola del coordinador.
      take: regla.maximo,
    });
    if (candidatos.length === 0) continue;

    const reactivados = await reactivar({
      tenantId,
      ids: candidatos.map((l) => l.id),
      motivo: `Reactivado automaticamente tras ${regla.dias} dias`,
      porNombre: "Regla automatica",
    });

    if (reactivados > 0) resumen.push({ tenantId, reactivados });
  }

  return resumen;
}

function startReactivarDescartadosJob() {
  const tick = async () => {
    try {
      const r = await reactivarVencidos();
      for (const { tenantId, reactivados } of r) {
        console.log(`reactivacion de descartados: ${reactivados} leads volvieron a la cola (tenant ${tenantId})`);
      }
    } catch (err) {
      console.error("fallo la reactivacion de descartados", err);
    }
  };

  setInterval(tick, INTERVAL_MS);
  // Holgura al arrancar para no competir con el resto del arranque.
  setTimeout(tick, 6 * 60 * 1000);
}

module.exports = { startReactivarDescartadosJob, reactivarVencidos };
