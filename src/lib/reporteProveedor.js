// Lo que un proveedor de leads puede ver de los leads que mando.
//
// El criterio: el proveedor necesita saber si su base sirvio, no como
// trabaja la operacion. Por eso aqui no sale ni el monto de la venta, ni la
// comision, ni quien atendio el lead. Lo que si sale es por que se cayo
// cada lead -- que es justo lo que le permite discutir el cobro y corregir
// su fuente.
//
// Lo usan dos consumidores distintos (la pantalla del proveedor y la API
// externa) y por eso vive aqui: son los mismos datos vistos por dos
// puertas, y si cada una armara los suyos acabarian diciendo cosas
// distintas del mismo lead.
const prisma = require("./prisma");
const { POR_CLAVE, motivoLabel, esTrash } = require("./motivosDescarte");
const { getParametros } = require("./parametros");

// Las API keys del proveedor. Puede tener mas de una si rotó credenciales,
// y sus leads viejos siguen colgando de la anterior.
async function apiKeyIdsDe(userId, tenantId) {
  const keys = await prisma.apiKey.findMany({
    where: { createdByUserId: userId, tenantId },
    select: { id: true },
  });
  return keys.map((k) => k.id);
}

// En que termino un lead, en los terminos que le importan al proveedor.
function desenlaceDe(lead) {
  if (!lead) return { estado: "pendiente", detalle: "Recibido, aún sin asignar" };
  if (lead.status === "VENTA") return { estado: "vendido", detalle: "Venta concretada" };
  if (lead.status === "DESCARTADO") {
    return {
      estado: "descartado",
      detalle: motivoLabel(lead.motivoDescarte),
      motivo: lead.motivoDescarte ?? null,
      // La distincion que de verdad importa: si el lead nunca sirvio (y
      // entonces es un problema de la base que el proveedor mando) o si
      // sirvio y simplemente no compro (que es trabajo comercial).
      cuentaContraLaBase: esTrash(lead.motivoDescarte),
    };
  }
  return { estado: "en_proceso", detalle: "En seguimiento" };
}

// Los comentarios de un lead: lo que se registro al intentar trabajarlo.
//
// `incluirNotas` lo decide el ADMIN del espacio (parametro
// compartirNotasConProveedor). Las notas son texto libre que escribe la
// vendedora durante la llamada: son justo lo que el proveedor pide para
// validar un lead, pero tambien pueden traer cualquier cosa que se haya
// escrito ahi. Con el parametro apagado se sigue entregando el historial
// estructurado, que es el que permite auditar sin exponer texto suelto.
function comentariosDeLead(lead, { incluirNotas }) {
  const intentos = (lead.llamadas ?? []).map((ll) => ({
    fecha: ll.fecha,
    contestada: ll.contestada,
    duracionSegundos: ll.duracion ?? null,
    resultado: ll.resultado ?? null,
    estadoAntes: ll.estadoAntes ?? null,
    estadoDespues: ll.estadoDespues ?? null,
    ...(incluirNotas ? { nota: ll.notas ?? null } : {}),
  }));

  const desenlace = desenlaceDe(lead);

  return {
    folio: lead.folio ?? null,
    folioPS: lead.folioPS ?? null,
    estado: desenlace.estado,
    detalleEstado: desenlace.detalle,
    motivoDescarte: desenlace.motivo ?? null,
    motivoDescarteLabel: lead.motivoDescarte ? motivoLabel(lead.motivoDescarte) : null,
    cuentaContraLaBase: desenlace.cuentaContraLaBase ?? null,
    ...(incluirNotas ? { notaDescarte: lead.motivoDescarteNota ?? null } : {}),
    intentos,
    totalIntentos: intentos.length,
    // Separar "le marcamos 5 veces y nunca contesto" de "hablamos con el 5
    // veces" es la diferencia entre un numero muerto y un cliente que no
    // quiso: sin esto el proveedor no puede discutir un descarte.
    vecesQueContesto: intentos.filter((i) => i.contestada).length,
    ultimaDevolucion: lead.devueltoAt
      ? { fecha: lead.devueltoAt, motivo: lead.devueltoMotivo ?? null }
      : null,
  };
}

// Cuanto sirvio la base que mando este proveedor, en el periodo pedido.
function resumirCalidad(leads) {
  const resumen = {
    enviados: leads.length,
    sinAsignar: 0,
    enProceso: 0,
    vendidos: 0,
    descartados: 0,
    // De los descartados, los que nunca sirvieron. Es el numero del que
    // sale "de cada 100 que mando, cuantos eran utilizables".
    descartadosPorBase: 0,
    descartadosPorVenta: 0,
    porMotivo: {},
  };

  for (const incoming of leads) {
    const lead = incoming.assignedLead;
    if (!lead) {
      resumen.sinAsignar += 1;
      continue;
    }
    if (lead.status === "VENTA") {
      resumen.vendidos += 1;
    } else if (lead.status === "DESCARTADO") {
      resumen.descartados += 1;
      const clave = lead.motivoDescarte ?? "SIN_MOTIVO";
      if (!resumen.porMotivo[clave]) {
        resumen.porMotivo[clave] = {
          motivo: clave,
          label: motivoLabel(lead.motivoDescarte),
          total: 0,
          cuentaContraLaBase: esTrash(lead.motivoDescarte),
          ayuda: POR_CLAVE[clave]?.ayuda ?? null,
        };
      }
      resumen.porMotivo[clave].total += 1;
      if (esTrash(lead.motivoDescarte)) resumen.descartadosPorBase += 1;
      else resumen.descartadosPorVenta += 1;
    } else {
      resumen.enProceso += 1;
    }
  }

  const trabajados = resumen.enviados - resumen.sinAsignar;

  return {
    ...resumen,
    porMotivo: Object.values(resumen.porMotivo).sort((a, b) => b.total - a.total),
    // Sobre lo trabajado, no sobre lo enviado: un lead que todavia no se
    // ha tocado no dice nada de la calidad de la base.
    calidadBase:
      trabajados > 0 ? Math.round(((trabajados - resumen.descartadosPorBase) / trabajados) * 100) : null,
    conversion: trabajados > 0 ? Math.round((resumen.vendidos / trabajados) * 100) : null,
  };
}

async function puedeVerNotas(tenantId) {
  const params = await getParametros(tenantId);
  return params.compartirNotasConProveedor !== false;
}

// El include que necesita comentariosDeLead. En un solo lugar para que las
// dos puertas traigan exactamente los mismos campos.
const INCLUDE_COMENTARIOS = {
  llamadas: {
    orderBy: { fecha: "asc" },
    select: {
      fecha: true,
      contestada: true,
      duracion: true,
      resultado: true,
      notas: true,
      estadoAntes: true,
      estadoDespues: true,
    },
  },
};

module.exports = {
  apiKeyIdsDe,
  comentariosDeLead,
  resumirCalidad,
  desenlaceDe,
  puedeVerNotas,
  INCLUDE_COMENTARIOS,
};
