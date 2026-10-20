// Ciclo de vida de un lead -- son los únicos cuatro estatus que existen.
// Cualquier filtro, conteo o reporte debe salir de aquí y no de listas
// sueltas regadas por las rutas (así cuando cambie el ciclo, cambia en un
// solo lugar).
//
// Los nombres del enum se conservaron donde ya existían (VENTA, REAGENDADO)
// para no romper el histórico ni los contratos de /api/external; la etiqueta
// que ve la gente es la de LEAD_STATUS_LABELS.
const LEAD_STATUSES = ["NUEVO", "REAGENDADO", "DESCARTADO", "VENTA"];

const LEAD_STATUS_LABELS = {
  NUEVO: "Nuevo ingreso",
  REAGENDADO: "Re-Llamar",
  DESCARTADO: "Descartado",
  VENTA: "Concretado",
};

const LEAD_STATUS_DESCRIPCIONES = {
  NUEVO: "Ingresado a sistema",
  REAGENDADO: "El cliente pide llamar otro día",
  DESCARTADO: "El cliente expresa que no lo quiere",
  VENTA: "Venta aceptada por el cliente",
};

// Un lead sigue "abierto" mientras se le pueda volver a llamar.
const LEAD_STATUSES_ABIERTOS = ["NUEVO", "REAGENDADO"];

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
  isLeadStatus,
  parseLeadStatus,
  leadStatusLabel,
};
