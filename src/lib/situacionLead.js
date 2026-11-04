// Dónde está el lead ahora mismo.
//
// El documento separa tres cosas que antes vivían revueltas en `status`:
//
//   A. estatus principal   en qué punto del ciclo va (NUEVO, VENTA...)
//   B. subestatus          qué pasó en la última llamada (Lead.substatus)
//   C. situación operativa DÓNDE está el lead  <- esto
//
// La tercera es la que faltaba, y es la que contesta la pregunta de la
// coordinadora: "¿puedo hacer algo con este lead ahora?". `status` no la
// contesta -- dos leads NUEVO pueden estar uno repartible y el otro
// bloqueado tres horas por el protocolo -- y hasta ahora había que deducirla
// cruzando cuatro campos (vendedorId, disponibleDesde, fechaReagenda,
// status) en cada pantalla que la necesitara. Cada una lo deducía un poco
// distinto.
//
// Es SIEMPRE calculada, nunca almacenada: se deriva de campos que ya
// existen, así que guardarla crearía una segunda verdad que puede quedar
// desfasada de la primera. Lo único que sí se guarda es la situación ANTES
// y DESPUÉS de cada movimiento, en la bitácora de asignaciones, porque eso
// es historia y la historia no se recalcula.
const { LEAD_STATUSES_ABIERTOS } = require("./leadStatus");

const SITUACIONES = {
  ASIGNADO: {
    clave: "asignado",
    label: "Asignado",
    ayuda: "Una vendedora lo tiene y lo está trabajando.",
  },
  DISPONIBLE: {
    clave: "disponible",
    label: "Disponible para asignación",
    ayuda: "Sin vendedora y sin candado: se puede repartir ahora mismo.",
  },
  EN_ESPERA: {
    clave: "en_espera",
    label: "En espera por intervalo",
    ayuda: "Rebotó y cumple el intervalo del protocolo. Todavía no se puede repartir.",
  },
  RELLAMADA: {
    clave: "rellamada",
    label: "Con llamada programada",
    ayuda: "El cliente pidió una hora concreta.",
  },
  CERRADO: {
    clave: "cerrado",
    label: "Cerrado",
    ayuda: "Vendido, descartado o no concretado. Ya no es trabajo de nadie.",
  },
};

// El orden de evaluación NO es arbitrario y es la única parte delicada:
//
//   1. cerrado      manda sobre todo: un lead cerrado no está en ninguna
//                   cola aunque le queden relojes sin limpiar.
//   2. rellamada    una cita pactada con el cliente manda sobre el resto,
//                   la tenga quien la tenga. Es lo único de esta lista que
//                   se prometió por teléfono.
//   3. asignado     tiene dueña.
//   4. en espera    sin dueña y con candado vigente.
//   5. disponible   todo lo demás.
//
// Si "asignado" se evaluara antes que "rellamada", una rellamada que se
// quedó con su vendedora se leería como un lead normal en su lista y la
// hora pactada dejaría de destacar.
function situacionDe(lead, ahora = new Date()) {
  if (!LEAD_STATUSES_ABIERTOS.includes(lead.status)) return SITUACIONES.CERRADO;
  if (lead.status === "REAGENDADO" && lead.fechaReagenda) return SITUACIONES.RELLAMADA;
  if (lead.vendedorId) return SITUACIONES.ASIGNADO;
  if (lead.disponibleDesde && new Date(lead.disponibleDesde) > ahora) return SITUACIONES.EN_ESPERA;
  return SITUACIONES.DISPONIBLE;
}

// La clave sola, que es lo que se guarda en la bitácora.
function claveSituacion(lead, ahora = new Date()) {
  return situacionDe(lead, ahora).clave;
}

// Cuándo vuelve a tocar algo con este lead.
//
// El documento lo pide en el historial ("fecha/hora de próxima
// disponibilidad o rellamada") y son dos relojes distintos según dónde
// esté: la hora pactada si hay cita, el fin del candado si está esperando.
// Un lead disponible o cerrado no tiene próxima acción programada.
function proximaAccionDe(lead) {
  if (lead.status === "REAGENDADO" && lead.fechaReagenda) return lead.fechaReagenda;
  if (lead.disponibleDesde) return lead.disponibleDesde;
  return null;
}

module.exports = { SITUACIONES, situacionDe, claveSituacion, proximaAccionDe };
