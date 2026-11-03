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
  //
  // Esta mitad del catalogo la fija el documento de secuencialidad de
  // llamada: son los motivos con los que la vendedora califica una venta
  // rechazada, despues de que el cliente contesto.
  {
    clave: "SIN_DINERO",
    label: "No tiene dinero",
    ayuda: "Le interesa pero no puede pagarlo ahora.",
    culpaDelProveedor: false,
  },
  {
    clave: "COMPRO_SIMILAR",
    label: "Compró otro producto similar",
    ayuda: "Ya resolvió su necesidad con otro producto.",
    culpaDelProveedor: false,
  },
  {
    clave: "ESPERABA_MUESTRAS",
    label: "Pensó que le enviarían muestras gratis",
    ayuda: "Dejó sus datos creyendo que no tenía costo.",
    culpaDelProveedor: false,
  },
  {
    clave: "OTRO",
    label: "Otro motivo",
    ayuda: "Cualquier otra razón. Conviene escribir la nota.",
    culpaDelProveedor: false,
  },

  // --- Descartes automaticos del protocolo de 72 horas ---
  //
  // No los elige nadie: los pone el sistema cuando un lead agota sus 72
  // horas en la cola sin que el cliente conteste (ver
  // src/lib/protocoloLeads.js). Van aparte de NO_CONTESTO, que es el
  // descarte manual, para poder distinguir en el reporte lo que decidio
  // una persona de lo que decidio el reloj.
  {
    clave: "NO_CONTESTO_72H",
    label: "No contestó en 72 horas",
    ayuda: "Cliente no contestó después de 72 horas en cola.",
    culpaDelProveedor: true,
    automatico: true,
  },
  {
    clave: "RECHAZO_72H",
    label: "Rechazó las llamadas 72 horas",
    ayuda: "Cliente rechazó las llamadas después de 72 horas en cola.",
    culpaDelProveedor: true,
    automatico: true,
  },
  {
    clave: "FUERA_SERVICIO_72H",
    label: "Fuera de servicio 72 horas",
    ayuda: "Número fuera de servicio después de 72 horas en cola.",
    culpaDelProveedor: true,
    automatico: true,
  },

  // --- Retirados del catalogo ---
  //
  // Ya no se ofrecen al descartar, pero siguen aqui porque hay leads
  // historicos que los traen: sin su entrada, los reportes mostrarian la
  // clave cruda ("NO_LE_INTERESA") en vez del texto, y el porcentaje de
  // calidad de la base cambiaria de significado hacia atras.
  {
    clave: "NO_LE_INTERESA",
    label: "No le interesa",
    ayuda: "Contestó, escuchó la oferta y no la quiere.",
    culpaDelProveedor: false,
    obsoleto: true,
  },
  {
    clave: "PRECIO",
    label: "Por el precio",
    ayuda: "Le interesa pero le parece caro.",
    culpaDelProveedor: false,
    obsoleto: true,
  },
  {
    clave: "LO_PENSARA",
    label: "Lo pensará / no ahora",
    ayuda: "No cierra hoy y tampoco quiere que se le vuelva a llamar.",
    culpaDelProveedor: false,
    obsoleto: true,
  },
  {
    clave: "YA_COMPRO",
    label: "Ya lo compró en otro lado",
    ayuda: "Consiguió el producto por otra vía.",
    culpaDelProveedor: false,
    obsoleto: true,
  },
];

const CLAVES = MOTIVOS.map((m) => m.clave);
// Los que se le ofrecen a la vendedora: sin los retirados y sin los que
// pone el protocolo solo.
const MOTIVOS_VIGENTES = MOTIVOS.filter((m) => !m.obsoleto && !m.automatico);
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
  MOTIVOS_VIGENTES,
  CLAVES,
  CLAVES_TRASH,
  POR_CLAVE,
  esMotivoValido,
  parseMotivo,
  esTrash,
  motivoLabel,
};
