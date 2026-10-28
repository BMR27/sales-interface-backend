// Por que se descarto un lead.
//
// Existe para una sola pregunta de negocio: que tan buena es la base que
// manda el proveedor. De ahi sale cuantos leads pedir para una meta de
// venta ("con 20% de calidad, para 40 ventas hay que pedir 200").
//
// La distincion que hace util a este catalogo NO es el motivo en si, es
// `culpaDelProveedor`. Son dos cosas distintas que antes caian en el mismo
// cubo DESCARTADO:
//
//   trash      el lead nunca sirvio -- numero inexistente, equivocado,
//              duplicado. El proveedor cobro por algo que no era un lead.
//   no vendio  el lead era real, contesto, y no quiso comprar. Eso es
//              trabajo comercial, no una falla de la base.
//
// Meter los dos en "trash" castiga el porcentaje de calidad y lleva a
// pedir leads de mas, que es justo el error que este catalogo evita.
//
// El motivo se CAPTURA, no se deduce. src/lib/calidadLeads.js sigue
// infiriendolo del historial de llamadas para los leads viejos que no lo
// traen, pero lo capturado siempre manda: Twilio no distingue bien un
// numero inexistente de uno apagado, y un lead llamado fuera del marcador
// no deja rastro que deducir.
const MOTIVOS = [
  // --- Culpa del proveedor: el lead nunca sirvio ---
  {
    clave: "NUMERO_NO_EXISTE",
    label: "El número no existe",
    ayuda: "La operadora dice que el número no está asignado.",
    culpaDelProveedor: true,
  },
  {
    clave: "NUMERO_EQUIVOCADO",
    label: "Número equivocado",
    ayuda: "Contestan, pero no es la persona del lead ni la conocen.",
    culpaDelProveedor: true,
  },
  {
    clave: "NO_CONTESTO",
    label: "No contestó",
    ayuda: "Se agotaron los intentos y nunca contestó.",
    culpaDelProveedor: true,
  },
  {
    clave: "DUPLICADO",
    label: "Lead duplicado",
    ayuda: "El mismo cliente ya había entrado antes.",
    culpaDelProveedor: true,
  },
  {
    clave: "FUERA_DE_COBERTURA",
    label: "Fuera de cobertura",
    ayuda: "No se puede entregar en su domicilio.",
    culpaDelProveedor: true,
  },
  {
    clave: "NO_SOLICITO",
    label: "Nunca pidió informes",
    ayuda: "El cliente dice que no dejó sus datos en ningún lado.",
    culpaDelProveedor: true,
  },

  // --- El lead si servia: no se cerro la venta ---
  {
    clave: "NO_LE_INTERESA",
    label: "No le interesa",
    ayuda: "Contestó, escuchó la oferta y no la quiere.",
    culpaDelProveedor: false,
  },
  {
    clave: "PRECIO",
    label: "Por el precio",
    ayuda: "Le interesa pero le parece caro.",
    culpaDelProveedor: false,
  },
  {
    clave: "LO_PENSARA",
    label: "Lo pensará / no ahora",
    ayuda: "No cierra hoy y tampoco quiere que se le vuelva a llamar.",
    culpaDelProveedor: false,
  },
  {
    clave: "YA_COMPRO",
    label: "Ya lo compró en otro lado",
    ayuda: "Consiguió el producto por otra vía.",
    culpaDelProveedor: false,
  },
  {
    clave: "OTRO",
    label: "Otro motivo",
    ayuda: "Cualquier otra razón. Conviene escribir la nota.",
    culpaDelProveedor: false,
  },
];

const CLAVES = MOTIVOS.map((m) => m.clave);
const POR_CLAVE = Object.fromEntries(MOTIVOS.map((m) => [m.clave, m]));

// Los que cuentan contra la calidad de la base.
const CLAVES_TRASH = MOTIVOS.filter((m) => m.culpaDelProveedor).map((m) => m.clave);

function esMotivoValido(clave) {
  return typeof clave === "string" && CLAVES.includes(clave);
}

// Normaliza lo que llegue del cliente. Devuelve null si no es un motivo del
// catalogo, para que quien llame decida si es 400 o si lo deja vacio.
function parseMotivo(valor) {
  if (typeof valor !== "string") return null;
  const limpio = valor.trim().toUpperCase();
  return esMotivoValido(limpio) ? limpio : null;
}

function esTrash(clave) {
  return POR_CLAVE[clave]?.culpaDelProveedor === true;
}

function motivoLabel(clave) {
  return POR_CLAVE[clave]?.label ?? clave ?? "Sin motivo";
}

module.exports = {
  MOTIVOS,
  CLAVES,
  CLAVES_TRASH,
  POR_CLAVE,
  esMotivoValido,
  parseMotivo,
  esTrash,
  motivoLabel,
};
