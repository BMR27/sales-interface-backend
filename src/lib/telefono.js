// Ocultamiento del telefono del lead para la vendedora.
//
// La vendedora ve solo los ultimos 4 digitos: suficiente para confirmarle al
// cliente que marco bien, insuficiente para llevarse la base de contactos a
// otra parte. Marcar sigue funcionando porque el numero completo nunca sale
// del servidor -- el marcador manda el id del lead y es el webhook de TwiML
// el que resuelve a que numero llamar (ver src/routes/voice.js).
//
// Esto se aplica en el servidor y no en la pantalla a proposito: enmascarar
// en el frontend dejaria el numero completo viajando en la respuesta, donde
// cualquiera lo lee desde las herramientas del navegador. Seria teatro.

const VISIBLES = 4;

// Roles que ven el telefono completo. El ADMIN y la coordinadora lo
// necesitan: son quienes llaman a los prepagos, corrigen datos y atienden
// los reclamos de entrega.
const ROLES_CON_TELEFONO = ["ADMIN", "SUPER_ADMIN", "COORDINADOR"];

function ocultaTelefono(rol) {
  return !ROLES_CON_TELEFONO.includes(rol);
}

// "+524433450550" -> "•••••• 0550". Conserva los ultimos 4 digitos reales y
// sustituye el resto, sin revelar cuantos digitos tenia el original.
function enmascararTelefono(telefono) {
  const digitos = String(telefono || "").replace(/\D/g, "");
  if (!digitos) return "";
  if (digitos.length <= VISIBLES) return digitos;
  return `•••••• ${digitos.slice(-VISIBLES)}`;
}

// Devuelve el lead con el telefono enmascarado si al rol no le corresponde
// verlo. Acepta null/undefined para poder encadenarlo sin comprobar antes.
function ocultarTelefonoLead(lead, rol) {
  if (!lead || !ocultaTelefono(rol)) return lead;
  return { ...lead, telefono: enmascararTelefono(lead.telefono) };
}

function ocultarTelefonoLeads(leads, rol) {
  if (!Array.isArray(leads) || !ocultaTelefono(rol)) return leads;
  return leads.map((l) => ocultarTelefonoLead(l, rol));
}

module.exports = {
  ocultaTelefono,
  enmascararTelefono,
  ocultarTelefonoLead,
  ocultarTelefonoLeads,
  ROLES_CON_TELEFONO,
};
