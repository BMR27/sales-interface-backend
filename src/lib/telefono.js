// Ocultamiento del telefono del lead para la vendedora.
//
// Con el interruptor encendido (Configuracion > Operacion), la vendedora ve
// solo los ultimos 4 digitos: suficiente para confirmarle al cliente que
// marco bien, insuficiente para llevarse la base de contactos a otra parte.
// Marcar sigue funcionando porque el numero completo nunca sale del servidor
// -- el marcador manda el id del lead y es el webhook de TwiML el que
// resuelve a que numero llamar (ver src/routes/voice.js).
//
// Esto se aplica en el servidor y no en la pantalla a proposito: enmascarar
// en el frontend dejaria el numero completo viajando en la respuesta, donde
// cualquiera lo lee desde las herramientas del navegador. Seria teatro. Por
// eso tambien las funciones son async: el parametro vive en la base.

const { getParametros } = require("./parametros");

const VISIBLES = 4;

// Roles que ven el telefono completo pase lo que pase. El ADMIN y la
// coordinadora lo necesitan: son quienes llaman a los prepagos, corrigen
// datos y atienden los reclamos de entrega.
const ROLES_CON_TELEFONO = ["ADMIN", "SUPER_ADMIN", "COORDINADOR"];

// El interruptor es solo para la vendedora. Cualquier otro rol que no este
// en ROLES_CON_TELEFONO (el proveedor de leads, por ejemplo) queda
// enmascarado siempre: apagar el interruptor no es permiso para abrirle la
// base de contactos a quien nunca la tuvo.
async function ocultaTelefono(user) {
  if (!user) return true;
  if (ROLES_CON_TELEFONO.includes(user.rol)) return false;
  if (user.rol !== "VENDEDOR") return true;

  const params = await getParametros(user.tenantId);
  return params.ocultarTelefonoVendedor !== false;
}

// "+524433450550" -> "•••••• 0550". Conserva los ultimos 4 digitos reales y
// sustituye el resto, sin revelar cuantos digitos tenia el original.
function enmascararTelefono(telefono) {
  const digitos = String(telefono || "").replace(/\D/g, "");
  if (!digitos) return "";
  if (digitos.length <= VISIBLES) return digitos;
  return `•••••• ${digitos.slice(-VISIBLES)}`;
}

// Devuelve el lead con el telefono enmascarado si al usuario no le
// corresponde verlo. Acepta null/undefined para poder encadenarlo sin
// comprobar antes.
async function ocultarTelefonoLead(lead, user) {
  if (!lead || !(await ocultaTelefono(user))) return lead;
  return { ...lead, telefono: enmascararTelefono(lead.telefono) };
}

async function ocultarTelefonoLeads(leads, user) {
  if (!Array.isArray(leads) || !(await ocultaTelefono(user))) return leads;
  return leads.map((l) => ({ ...l, telefono: enmascararTelefono(l.telefono) }));
}

module.exports = {
  ocultaTelefono,
  enmascararTelefono,
  ocultarTelefonoLead,
  ocultarTelefonoLeads,
  ROLES_CON_TELEFONO,
};
