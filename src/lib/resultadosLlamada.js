// Que paso en la llamada, en palabras de la vendedora.
//
// Este catalogo es el unico lugar donde se decide que le pasa a un lead
// cuando una llamada no termina en venta. La vendedora elige UNA de estas
// siete cosas -- lo que realmente vio -- y el sistema deriva el estatus, la
// cola y los tiempos. Ella nunca elige "Trash" ni "No concretado": esos son
// consecuencias, no observaciones, y dejarselos elegir fue justo lo que
// produjo los descartes prematuros que este cambio corrige.
//
// La distincion que vertebra la tabla:
//
//   RECHAZAR UNA LLAMADA  no es  RECHAZAR UNA COMPRA
//
// Colgar el telefono no dice nada sobre si el cliente quiere el producto:
// puede estar manejando. Por eso "Rechaza la llamada" devuelve el lead a la
// cola con tres horas de espera, y solo "Cliente rechaza compra" -- donde
// hubo conversacion y una negativa explicita -- cierra el lead.
//
// Lo que sustituye: hasta ahora el desenlace lo deducia Twilio del codigo
// de la llamada (`no-answer`, `busy`, `failed`). Twilio no distingue "el
// cliente colgo" de "el telefono comunicaba", ni sabe nada de lo que se
// dijo; y una llamada hecha fuera del marcador no dejaba desenlace alguno.
// La clasificacion de Twilio se conserva como respaldo (ver
// clasificarDesenlace en protocoloLeads.js) para las llamadas que nadie
// tipifica a mano, pero lo que elige la persona siempre manda.

// --- Efectos posibles ---
//
// COLA   el lead vuelve al queue de la coordinadora con un candado de
//        espera. NO se cierra, NO se reporta como trash a CF.
// TRASH  cierre definitivo con causa valida.
const EFECTO_COLA = "COLA";
const EFECTO_TRASH = "TRASH";

const RESULTADOS = [
  // --- Vuelven a la cola. No hubo conversacion: no hay nada que concluir ---
  {
    clave: "NO_CONTESTA",
    label: "No contesta / Buzón",
    ayuda: "Sonaron los rings y nadie contestó, o entró el buzón.",
    efecto: EFECTO_COLA,
    // Clasificacion del protocolo: es la que decide cuanto espera el lead.
    desenlace: "NO_CONTESTA",
    icono: "buzon",
  },
  {
    clave: "RECHAZA_LLAMADA",
    label: "Rechaza la llamada",
    ayuda: "Colgó sin escuchar, o el número comunica. No dijo que no quiera el producto.",
    efecto: EFECTO_COLA,
    desenlace: "RECHAZA",
    icono: "colgar",
  },
  {
    clave: "FUERA_DE_SERVICIO",
    label: "Temporalmente fuera de servicio",
    ayuda: "La red no alcanza el número: apagado, sin señal o fuera del área.",
    efecto: EFECTO_COLA,
    desenlace: "FUERA_DE_SERVICIO",
    icono: "senal",
  },

  // --- Cierran el lead. Hay una causa definitiva ---
  {
    clave: "NUMERO_NO_EXISTE",
    label: "Número no existe",
    ayuda: "La operadora dice que el número no está asignado a nadie.",
    efecto: EFECTO_TRASH,
    // Clave del catalogo de src/lib/motivosDescarte.js.
    motivoDescarte: "NUMERO_NO_EXISTE",
    requiereConfirmacion: true,
    icono: "alerta",
  },
  {
    clave: "CLIENTE_RECHAZA_COMPRA",
    label: "Cliente rechaza compra",
    ayuda: "Hablaste con el cliente y no quiere comprar. Hay que decir por qué.",
    efecto: EFECTO_TRASH,
    // El motivo NO esta fijo: sale del submotivo que se elija abajo. Es la
    // unica opcion que lo pide, y es obligatorio.
    requiereSubmotivo: true,
    requiereConfirmacion: true,
    // Es el unico resultado que implica que el cliente contesto. Importa
    // para el protocolo: un lead que ya hablo con alguien no se procesa
    // como "nunca contestó".
    implicaContacto: true,
    icono: "carrito",
  },
  {
    clave: "NUMERO_DUPLICADO",
    label: "Número duplicado",
    ayuda: "Este mismo cliente ya había entrado antes con otro folio.",
    efecto: EFECTO_TRASH,
    motivoDescarte: "DUPLICADO",
    requiereConfirmacion: true,
    // Cuando se pueda identificar el lead original se guarda en la nota.
    // Por ahora es opcional: pedirlo obligatorio bloquearia el cierre de
    // duplicados que la vendedora reconoce pero no puede ubicar.
    icono: "duplicado",
  },
  {
    clave: "BLACKLIST",
    label: "Blacklist identificado",
    ayuda: "Número que ya está marcado para no volver a contactar.",
    efecto: EFECTO_TRASH,
    motivoDescarte: "BLACKLIST",
    requiereConfirmacion: true,
    icono: "escudo",
  },
];

// Los motivos que explican un "Cliente rechaza compra". Son claves del
// catalogo de motivosDescarte.js, no una lista aparte: de ahi sale el
// reporte de calidad de la base, y duplicar el catalogo lo partiria en dos.
const SUBMOTIVOS_RECHAZO_COMPRA = [
  "SIN_DINERO",
  "NO_SOLICITO",
  "COMPRO_SIMILAR",
  "ESPERABA_MUESTRAS",
  "OTRO",
];

// "Otro" sin texto no explica nada y es justo el cubo donde se esconde lo
// que el reporte necesita saber.
const SUBMOTIVO_REQUIERE_NOTA = "OTRO";

const POR_CLAVE = Object.fromEntries(RESULTADOS.map((r) => [r.clave, r]));
const CLAVES = RESULTADOS.map((r) => r.clave);

function esResultadoValido(clave) {
  return typeof clave === "string" && CLAVES.includes(clave);
}

// Normaliza lo que llegue del navegador. Devuelve null si no es del
// catalogo, para que la ruta responda 400 en vez de guardar basura.
function parseResultado(valor) {
  if (typeof valor !== "string") return null;
  const limpio = valor.trim().toUpperCase();
  return esResultadoValido(limpio) ? POR_CLAVE[limpio] : null;
}

function esSubmotivoValido(clave) {
  return typeof clave === "string" && SUBMOTIVOS_RECHAZO_COMPRA.includes(clave.trim().toUpperCase());
}

// Valida la combinacion completa antes de tocar nada. Devuelve
// { resultado, motivoDescarte, nota } o { error } -- nunca a medias: una
// accion que se aplica a medias deja el lead en un estado que nadie pidio.
function validarSeleccion({ resultado, submotivo, nota }) {
  const def = parseResultado(resultado);
  if (!def) {
    return { error: `Resultado de llamada inválido. Valores: ${CLAVES.join(", ")}` };
  }

  const notaLimpia = typeof nota === "string" ? nota.trim().slice(0, 300) : "";

  if (!def.requiereSubmotivo) {
    return { def, motivoDescarte: def.motivoDescarte ?? null, nota: notaLimpia || null };
  }

  const sub = typeof submotivo === "string" ? submotivo.trim().toUpperCase() : "";
  if (!sub) {
    return { error: "Elige el motivo de rechazo de compra" };
  }
  if (!esSubmotivoValido(sub)) {
    return { error: `Motivo de rechazo inválido. Valores: ${SUBMOTIVOS_RECHAZO_COMPRA.join(", ")}` };
  }
  if (sub === SUBMOTIVO_REQUIERE_NOTA && !notaLimpia) {
    return { error: "Escribe el motivo de rechazo" };
  }

  return { def, motivoDescarte: sub, nota: notaLimpia || null };
}

module.exports = {
  RESULTADOS,
  CLAVES,
  POR_CLAVE,
  EFECTO_COLA,
  EFECTO_TRASH,
  SUBMOTIVOS_RECHAZO_COMPRA,
  SUBMOTIVO_REQUIERE_NOTA,
  esResultadoValido,
  parseResultado,
  validarSeleccion,
};
