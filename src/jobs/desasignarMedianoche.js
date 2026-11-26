// A las 12 de la noche los leads abiertos se le quitan a quien los tenga.
//
// Regla de operación: cada día arranca con la cola completa y la
// coordinadora la reparte con «Ejecutar asignación» entre quienes SÍ están
// ese día. Sin esto, un lead que una vendedora no alcanzó a trabajar se
// quedaba en su lista al día siguiente aunque ella no viniera, y nadie más
// lo veía en la cola.
//
// Las rellamadas no pierden a su dueña: antes de soltarlas se anota quién
// la generó (reagendaVendedorSugeridoId), que es lo que el reparto usa para
// devolvérsela (ver planificarReparto). El cliente espera SU llamada.
//
// Corre cada 5 minutos y actúa una sola vez por día por espacio, entre las
// 12:00 y las 5:59 de la mañana (hora de la operación). No sólo en el
// minuto exacto: si el servicio se reinició a medianoche, lo hace en cuanto
// vuelve, siempre antes de que empiece el turno.
const prisma = require("../lib/prisma");
const { registrarAsignacion } = require("../lib/cicloLead");
const { LEAD_STATUSES_ABIERTOS } = require("../lib/leadStatus");
const { diaLocal, horaLocal } = require("../lib/fechasLocales");
const { emitir } = require("../lib/eventos");

const INTERVAL_MS = 5 * 60 * 1000;
const HORA_LIMITE = 6;
const CLAVE = "desasignacionDiariaHecha";
const LOTE = 50;

async function desasignarEspacio(tenantId, hoy) {
  const marca = await prisma.appSetting.findFirst({ where: { tenantId, key: CLAVE } });
  if (marca?.value === hoy) return 0;

  const leads = await prisma.lead.findMany({
    where: { tenantId, status: { in: LEAD_STATUSES_ABIERTOS }, vendedorId: { not: null } },
    select: {
      id: true, nombre: true, status: true, vendedorId: true, fechaReagenda: true,
      reagendaVendedorSugeridoId: true, disponibleDesde: true, disponibleHasta: true,
      vendedor: { select: { id: true, nombre: true } },
    },
  });

  for (let i = 0; i < leads.length; i += LOTE) {
    const lote = leads.slice(i, i + LOTE);
    await prisma.$transaction(async (tx) => {
      for (const l of lote) {
        const esRellamada = l.status === "REAGENDADO" && l.fechaReagenda;
        await tx.lead.update({
          where: { id: l.id },
          data: {
            vendedorId: null,
            ...(esRellamada && !l.reagendaVendedorSugeridoId ? { reagendaVendedorSugeridoId: l.vendedorId } : {}),
          },
        });
        await registrarAsignacion(tx, {
          leadId: l.id,
          tenantId,
          actor: null,
          anterior: l.vendedor,
          nuevo: null,
          evento: "devuelta",
          motivo: esRellamada
            ? "Cierre del día (12 a.m.): vuelve a la cola; el reparto se la devuelve a quien la generó"
            : "Cierre del día (12 a.m.): vuelve a la cola para el reparto",
          automatico: true,
          leadAntes: l,
          leadDespues: { ...l, vendedorId: null },
        });
      }
    }, { timeout: 60000 });
  }

  // La marca va al final: si algo falló a la mitad, la siguiente vuelta
  // termina lo que quedó (sólo toma leads que todavía tienen dueña).
  if (marca) await prisma.appSetting.update({ where: { id: marca.id }, data: { value: hoy } });
  else await prisma.appSetting.create({ data: { tenantId, key: CLAVE, value: hoy } });

  if (leads.length > 0) emitir(tenantId, "lead.devuelto", { total: leads.length, motivo: "cierre_del_dia" });
  return leads.length;
}

async function desasignarSiToca(ahora = new Date()) {
  if (horaLocal(ahora) >= HORA_LIMITE) return;
  const hoy = diaLocal(ahora);
  try {
    const tenants = await prisma.tenant.findMany({ where: { status: "ACTIVO" }, select: { id: true } });
    for (const t of tenants) {
      try {
        const n = await desasignarEspacio(t.id, hoy);
        if (n > 0) console.log(`cierre del día: ${n} leads devueltos a la cola en el espacio ${t.id}`);
      } catch (err) {
        // Un espacio que falla no puede dejar sin desasignar a los demás.
        console.error("cierre del día: fallo en el espacio", t.id, err);
      }
    }
  } catch (err) {
    console.error("cierre del día: no se pudo listar los espacios", err);
  }
}

function startDesasignarMedianocheJob() {
  setTimeout(() => {
    desasignarSiToca();
    setInterval(desasignarSiToca, INTERVAL_MS);
  }, 60 * 1000);
}

module.exports = { startDesasignarMedianocheJob, desasignarSiToca, desasignarEspacio };
