// Devolver a la cola leads que ya se habian descartado.
//
// Un descarte no siempre es definitivo: "no contesto" puede ser una mala
// racha de horarios, y "lo pensara" o "por el precio" son clientes reales
// que dijeron que no hoy. Volver a intentarlo semanas despues es trabajo
// comercial legitimo.
//
// Lo que NO se reactiva nunca, aunque alguien lo pida por error: los
// descartes que dicen que el lead no existe (numero inexistente o
// equivocado, duplicado) y los que dicen que no quiere que lo llamen
// (no le interesa, nunca pidio informes). Re-llamar ahi no es insistir,
// es molestar a alguien que ya dijo que no, y en el caso de
// NUNCA_PIDIO_INFORMES es llamar a quien nunca dio sus datos.
const prisma = require("./prisma");
const { getParametros } = require("./parametros");

// Los motivos que pueden volver a la cola.
const MOTIVOS_REACTIVABLES = ["NO_CONTESTO", "LO_PENSARA", "PRECIO"];

// Los leads descartados que cumplen el criterio.
//
// `antesDe` acota por antiguedad del descarte: reactivar algo que se
// descarto esta mañana es volver a llamar al mismo cliente el mismo dia.
function dondeReactivable(tenantId, { motivos, desde, hasta, antesDe } = {}) {
  const elegidos = (motivos?.length ? motivos : MOTIVOS_REACTIVABLES)
    .filter((m) => MOTIVOS_REACTIVABLES.includes(m));

  const where = {
    tenantId,
    status: "DESCARTADO",
    motivoDescarte: { in: elegidos.length ? elegidos : MOTIVOS_REACTIVABLES },
  };

  const rango = {};
  if (desde) rango.gte = desde;
  if (hasta) rango.lte = hasta;
  if (antesDe) rango.lte = antesDe;
  if (Object.keys(rango).length > 0) where.descartadoAt = rango;

  return where;
}

// Devuelve los leads a la cola. Es el mismo movimiento para el boton del
// admin y para la regla diaria: si cada uno escribiera sus campos, uno de
// los dos acabaria olvidando `reintentosDesde` y el protocolo volveria a
// descartar los leads en la primera llamada.
async function reactivar({ tenantId, ids, motivo, porNombre }) {
  if (!ids.length) return 0;

  const ahora = new Date();
  const { count } = await prisma.lead.updateMany({
    where: { id: { in: ids }, tenantId, status: "DESCARTADO" },
    data: {
      status: "NUEVO",
      vendedorId: null,
      asignadoAt: null,
      asignadoPorCoordinador: false,
      // El descarte deja de estar vigente: si se queda, el tablero de
      // calidad sigue contando como basura un lead que volvio a la cola.
      motivoDescarte: null,
      motivoDescarteNota: null,
      descartadoAt: null,
      descartadoPorId: null,
      // Empieza de cero para el protocolo de reintento.
      reintentosDesde: ahora,
      // Y sin espera: se puede repartir en cuanto el coordinador lo vea.
      disponibleDesde: null,
      devueltoAt: ahora,
      devueltoMotivo: motivo,
      devueltoPorNombre: porNombre,
    },
  });

  return count;
}

// Parametros de la regla diaria, ya normalizados.
async function reglaAutomatica(tenantId) {
  const p = await getParametros(tenantId);
  return {
    activa: p.reactivarDescartadosAuto === true,
    dias: p.reactivarDescartadosDias,
    maximo: p.reactivarDescartadosMaxDiarios,
  };
}

module.exports = {
  MOTIVOS_REACTIVABLES,
  dondeReactivable,
  reactivar,
  reglaAutomatica,
};
