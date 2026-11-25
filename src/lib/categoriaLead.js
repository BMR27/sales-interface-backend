// El estatus de trabajo de un lead: en que punto de la cola esta.
//
// Nacio como las secciones de la cola de la coordinadora, pero operacion
// lo pidio general: el administrador, la vendedora y los reportes tienen
// que hablar de "Nuevos", "Reintentos" o "En hold" con las mismas
// palabras y las mismas reglas. Si cada pantalla lo dedujera por su lado,
// el mismo lead saldria "Reintento" en una y "Nuevo sin llamadas" en otra.
//
// Las categorias, en el orden en que se trabajan:
//
//   nuevos               entro HOY y nadie le ha marcado
//   pendientes_antiguos  entro otro dia y nadie le ha marcado
//   rellamadas           el cliente pidio una hora concreta
//   reintentos           ya tiene intentos y se puede volver a llamar
//   en_espera            "En hold": rebotó y cumple el candado del
//                        protocolo (2, 3 o 4 horas segun el desenlace)
//   descartados          cerrado sin venta (descarte o 72 h agotadas)
//   concretados          cerrado en venta
//
// Es SIEMPRE calculada, nunca almacenada, por la misma razon que la
// situacion (situacionLead.js): sale de campos que ya existen y guardarla
// seria una segunda verdad que se desfasa -- un lead deja de ser "Nuevo" a
// medianoche sin que nadie lo toque.
//
// No mira a la vendedora a proposito. "Quien lo tiene" es otra pregunta,
// la contesta la situacion; un reintento sigue siendo reintento lo tenga
// quien lo tenga.
const { diaLocal, inicioDeHoy } = require("./fechasLocales");

const CATEGORIAS = [
  {
    id: "nuevos",
    titulo: "Nuevos 🔥",
    descripcion: "Leads recién entrados hoy, sin llamadas. Se contactan mejor mientras el cliente recuerda haber dejado sus datos.",
  },
  {
    id: "pendientes_antiguos",
    titulo: "Nuevos sin llamadas",
    descripcion: "Entraron en días anteriores y nadie les ha llamado.",
  },
  {
    id: "rellamadas",
    titulo: "Rellamadas",
    descripcion: "El cliente pidió una hora concreta. Atiéndelas antes de que venzan.",
  },
  {
    id: "reintentos",
    titulo: "Reintentos",
    descripcion: "Ya tienen intentos y se pueden llamar de nuevo.",
  },
  {
    id: "en_espera",
    titulo: "En hold",
    descripcion: "Bloqueados por el protocolo 2, 3 o 4 horas según el resultado de la última llamada.",
  },
  {
    id: "descartados",
    titulo: "Descartados",
    descripcion: "Se cerraron sin venta, por descarte o por agotarse el protocolo.",
  },
  {
    id: "concretados",
    titulo: "Concretados",
    descripcion: "Terminaron en venta.",
  },
];

const CATEGORIA_POR_ID = Object.fromEntries(CATEGORIAS.map((c) => [c.id, c]));

// ¿Es un lead NEW? Entro HOY y todavia no tiene intentos. Las dos
// condiciones importan: solo por la fecha, un lead de hoy al que ya se le
// marco tres veces seguiria luciendo intacto; solo por los intentos, uno
// de hace una semana que nadie toco competiria con los frescos.
function esNuevoDeHoy(lead, intentos, hoy) {
  return intentos === 0 && diaLocal(lead.createdAt) === hoy;
}

// `ahora` y `hoy` se pasan desde fuera para que todos los leads de una
// misma respuesta se clasifiquen contra el mismo instante.
//
// El orden importa:
//   1. los cierres mandan: un lead cerrado no esta en ninguna cola
//   2. la cita pactada manda sobre el resto: es lo unico que se le
//      prometio a un cliente por telefono
//   3. el candado: aunque tenga intentos, si esta bloqueado no se puede
//      llamar, que es justo lo que "Reintentos" promete
function categoriaDe(lead, { intentos, ahora = new Date(), hoy = diaLocal(ahora) }) {
  if (lead.status === "VENTA") return "concretados";
  if (lead.status === "DESCARTADO" || lead.status === "NO_CONCRETADO") return "descartados";
  if (lead.status === "REAGENDADO" && lead.fechaReagenda) return "rellamadas";
  if (lead.disponibleDesde && new Date(lead.disponibleDesde) > ahora) return "en_espera";
  if (intentos > 0) return "reintentos";
  return esNuevoDeHoy(lead, intentos, hoy) ? "nuevos" : "pendientes_antiguos";
}

// La misma regla escrita como filtro de Prisma, para filtrar listas en la
// base en vez de traer todo y clasificar en memoria. Tiene que decir
// EXACTAMENTE lo mismo que categoriaDe: cada rama excluye las anteriores.
// "Intentos" son las llamadas registradas, igual que en la cola.
function dondeCategoria(id, ahora = new Date()) {
  const abierto = { status: { in: ["NUEVO", "REAGENDADO"] } };
  const noRellamada = { NOT: { status: "REAGENDADO", fechaReagenda: { not: null } } };
  const sinCandado = { OR: [{ disponibleDesde: null }, { disponibleDesde: { lte: ahora } }] };

  switch (id) {
    case "concretados":
      return { status: "VENTA" };
    case "descartados":
      return { status: { in: ["DESCARTADO", "NO_CONCRETADO"] } };
    case "rellamadas":
      return { status: "REAGENDADO", fechaReagenda: { not: null } };
    case "en_espera":
      return { AND: [abierto, noRellamada, { disponibleDesde: { gt: ahora } }] };
    case "reintentos":
      return { AND: [abierto, noRellamada, sinCandado, { llamadas: { some: {} } }] };
    case "nuevos":
      return { AND: [abierto, noRellamada, sinCandado, { llamadas: { none: {} } }, { createdAt: { gte: inicioDeHoy(ahora) } }] };
    case "pendientes_antiguos":
      return { AND: [abierto, noRellamada, sinCandado, { llamadas: { none: {} } }, { createdAt: { lt: inicioDeHoy(ahora) } }] };
    default:
      return null;
  }
}

module.exports = { CATEGORIAS, CATEGORIA_POR_ID, esNuevoDeHoy, categoriaDe, dondeCategoria };
