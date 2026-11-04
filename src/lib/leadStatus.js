// Ciclo de vida de un lead -- son los únicos cinco estatus que existen.
// Cualquier filtro, conteo o reporte debe salir de aquí y no de listas
// sueltas regadas por las rutas (así cuando cambie el ciclo, cambia en un
// solo lugar).
//
// Los nombres del enum se conservaron donde ya existían (VENTA, REAGENDADO)
// para no romper el histórico ni los contratos de /api/external; la etiqueta
// que ve la gente es la de LEAD_STATUS_LABELS.
//
// NO_CONCRETADO es el quinto, y es el que faltaba: hasta ahora un lead al
// que se le llamó las veces que tocaba sin que nadie contestara acababa en
// DESCARTADO, el mismo cubo que un número inexistente. Son dos cosas
// distintas -- una es trabajo comercial agotado, la otra es una base mala --
// y mezclarlas desvirtuaba el porcentaje de calidad y hacía que CF recibiera
// como trash leads que nunca lo fueron.
const LEAD_STATUSES = ["NUEVO", "REAGENDADO", "DESCARTADO", "VENTA", "NO_CONCRETADO"];

const LEAD_STATUS_LABELS = {
  NUEVO: "Nuevo ingreso",
  REAGENDADO: "Re-Llamar",
  DESCARTADO: "Descartado",
  VENTA: "Concretado",
  NO_CONCRETADO: "No concretado",
};

const LEAD_STATUS_DESCRIPCIONES = {
  NUEVO: "Ingresado a sistema",
  REAGENDADO: "El cliente pide llamar otro día",
  DESCARTADO: "El cliente expresa que no lo quiere",
  VENTA: "Venta aceptada por el cliente",
  NO_CONCRETADO: "Se agotó el protocolo de 72 horas sin contacto efectivo",
};

// Un lead sigue "abierto" mientras se le pueda volver a llamar.
const LEAD_STATUSES_ABIERTOS = ["NUEVO", "REAGENDADO"];

// Los cierres. Ninguno vuelve a la cola por sí solo y ninguno se procesa
// por la regla de las 72 horas.
const LEAD_STATUSES_CERRADOS = ["DESCARTADO", "VENTA", "NO_CONCRETADO"];

// Los dos cierres SIN venta. Es lo que la coordinadora puede rehabilitar y
// lo que cuenta en el reporte de calidad de la base.
const LEAD_STATUSES_CERRADOS_SIN_VENTA = ["DESCARTADO", "NO_CONCRETADO"];

function esLeadAbierto(status) {
  return LEAD_STATUSES_ABIERTOS.includes(status);
}

function esLeadCerrado(status) {
  return LEAD_STATUSES_CERRADOS.includes(status);
}

function isLeadStatus(value) {
  return LEAD_STATUSES.includes(value);
}

// Normaliza lo que llegue por query string / body. Devuelve null si no es
// un estatus válido, para que quien llame decida si es 400 o simplemente
// ignorar el filtro.
function parseLeadStatus(value) {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return isLeadStatus(upper) ? upper : null;
}

function leadStatusLabel(status) {
  return LEAD_STATUS_LABELS[status] || status;
}

module.exports = {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_DESCRIPCIONES,
  LEAD_STATUSES_ABIERTOS,
  LEAD_STATUSES_CERRADOS,
  LEAD_STATUSES_CERRADOS_SIN_VENTA,
  esLeadAbierto,
  esLeadCerrado,
  isLeadStatus,
  parseLeadStatus,
  leadStatusLabel,
};
