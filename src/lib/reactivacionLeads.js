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
const { LEAD_STATUSES_CERRADOS_SIN_VENTA } = require("./leadStatus");

// Los motivos que pueden volver a la cola.
// Los que vale la pena reintentar semanas despues. SIN_DINERO entra
// porque la situacion del cliente cambia; los descartes automaticos de 72
// horas tambien, que es el caso de "esa racha de horarios fue mala".
// LO_PENSARA y PRECIO siguen aqui para los leads historicos que los traen,
// aunque ya no se puedan capturar (ver src/lib/motivosDescarte.js).
const MOTIVOS_REACTIVABLES = [
  "NO_CONTESTO",
  "NO_CONTESTO_72H",
  "RECHAZO_72H",
  "FUERA_SERVICIO_72H",
  "SIN_DINERO",
  "LO_PENSARA",
  "PRECIO",
];

// Los leads descartados que cumplen el criterio.
//
// `antesDe` acota por antiguedad del descarte: reactivar algo que se
// descarto esta mañana es volver a llamar al mismo cliente el mismo dia.
function dondeReactivable(tenantId, { motivos, desde, hasta, antesDe, busqueda } = {}) {
  const elegidos = (motivos?.length ? motivos : MOTIVOS_REACTIVABLES)
    .filter((m) => MOTIVOS_REACTIVABLES.includes(m));

  const where = {
    tenantId,
    // Los dos cierres sin venta son reactivables. NO_CONCRETADO es,
    // ademas, el caso mas claro: el lead era legitimo y solo se le acabo
    // el tiempo, asi que es justo el que vale la pena volver a intentar
    // pasado el plazo de enfriamiento.
    status: { in: LEAD_STATUSES_CERRADOS_SIN_VENTA },
  };

  // Buscar un lead concreto -- por telefono, folio o nombre -- no filtra
  // por motivo: ahi el admin esta corrigiendo un descarte que sabe que
  // estuvo mal, viendo ese lead y su motivo en pantalla. La lista cerrada
  // de motivos existe para la reactivacion masiva, donde nadie mira uno
  // por uno.
  const aguja = typeof busqueda === "string" ? busqueda.trim() : "";
  if (aguja) {
    const soloDigitos = aguja.replace(/\D/g, "");
    where.OR = [
      ...(soloDigitos.length >= 4 ? [{ telefono: { contains: soloDigitos } }] : []),
      { folioPS: { contains: aguja, mode: "insensitive" } },
      { folio: { contains: aguja, mode: "insensitive" } },
      { nombre: { contains: aguja, mode: "insensitive" } },
    ];
  } else {
    where.motivoDescarte = { in: elegidos.length ? elegidos : MOTIVOS_REACTIVABLES };
  }

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
    where: { id: { in: ids }, tenantId, status: { in: LEAD_STATUSES_CERRADOS_SIN_VENTA } },
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
      // La marca de atraso tambien se limpia: pertenecia al plazo anterior,
      // y arrastrarla haria que el lead naciera "atrasado" el mismo dia en
      // que vuelve a la cola.
      seguimientoIncompleto: false,
      seguimientoIncompletoAt: null,
      intentosEsperados: null,
      intentosRealizados: null,
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
