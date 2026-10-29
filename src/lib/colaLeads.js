// Que significa exactamente "sin asignar".
//
// Habia tres copias de este conteo -- la cola del coordinador, su tablero y
// el Resumen General del admin -- y ninguna coincidia con la lista que
// acompañaba: todas contaban `vendedorId: null` a secas, asi que sumaban
// los leads cerrados y, sobre todo, los que rebotaron por no contestar y
// siguen cumpliendo la espera del protocolo. El tablero prometia 48 leads
// por repartir y la cola tenia uno.
//
// Viven aqui para que el numero y la lista no puedan volver a separarse.
const { LEAD_STATUSES_ABIERTOS } = require("./leadStatus");
const { filtroDisponible } = require("./protocoloLeads");

// Lo que de verdad se puede repartir ahora: sin vendedora, todavia vivo y
// con la espera del protocolo ya cumplida.
function dondeRepartible(tenantId) {
  return {
    tenantId,
    vendedorId: null,
    status: { in: LEAD_STATUSES_ABIERTOS },
    ...filtroDisponible(),
  };
}

// Sin vendedora y vivo, pero todavia esperando su turno de re-llamada.
// Cuenta aparte: existe, pero no es trabajo disponible.
function dondeEnEspera(tenantId) {
  return {
    tenantId,
    vendedorId: null,
    status: { in: LEAD_STATUSES_ABIERTOS },
    disponibleDesde: { gt: new Date() },
  };
}

module.exports = { dondeRepartible, dondeEnEspera };
