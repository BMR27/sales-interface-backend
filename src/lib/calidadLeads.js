// Calidad de los leads que entran: de cada cien que llegan, cuantos valian
// la pena. Es la pregunta que se le hace al proveedor de leads, no a la
// vendedora.
//
// Las categorias NO son el status del lead. El status dice en que punto del
// ciclo esta ("DESCARTADO"); la calidad dice por que murio ("el numero no
// existia"). Esa diferencia es justo la que el tablero necesita y la que el
// enum LeadStatus no guarda: un lead con numero inventado y uno que dijo
// "no me interesa" caen los dos en DESCARTADO y no son el mismo problema.
//
// Como el motivo no se captura en ningun lado, se deduce del historial de
// llamadas (ver model Llamada): el desenlace que reporta Twilio y cuantas
// veces se marco sin que nadie contestara. Deducirlo tiene una ventaja que
// pedirselo a la vendedora no tiene -- clasifica tambien el historico, sin
// que nadie cambie su forma de trabajar -- y un costo que conviene decir en
// voz alta: la precision es la del dato de Twilio. Un numero apagado y uno
// inexistente a veces reportan lo mismo.

const { getParametros } = require("./parametros");
const { diaLocal, horaLocal } = require("./fechasLocales");
const { esTrash, POR_CLAVE } = require("./motivosDescarte");

// Twilio DialCallStatus: completed, busy, no-answer, failed, canceled.
// "failed" es el que la red devuelve cuando el numero no se puede alcanzar:
// no existe, esta mal formado o la operadora lo rechaza de plano.
const DESENLACE_INALCANZABLE = ["failed", "canceled"];

const CATEGORIAS = [
  { clave: "CONCRETADA", label: "Concretadas", buena: true },
  { clave: "REAGENDA", label: "Reagendas", buena: true },
  { clave: "NO_EXISTE", label: "Numero no existe", buena: false },
  { clave: "NO_CONTESTO", label: "No contesto (N intentos)", buena: false },
  { clave: "DESCARTADO_OTRO", label: "Descartado, otro motivo", buena: false },
  { clave: "EN_PROCESO", label: "En proceso", buena: null },
];

// Clasifica un lead. `llamadas` es el resumen de sus intentos.
//
// El orden importa y no es arbitrario: el status gana cuando prueba que
// hubo conversacion. Si la vendedora cerro la venta o el cliente pidio que
// le llamaran otro dia, alguien hablo con el -- da igual cuantos intentos
// fallidos hubo antes, ese lead servia. Solo cuando el status no prueba
// contacto se recurre a las llamadas para explicar por que.
// El motivo CAPTURADO manda sobre el deducido. La deduccion es una
// estimacion -- Twilio no distingue bien un numero inexistente de uno
// apagado, y un lead llamado fuera del marcador no deja rastro -- y las
// metricas de calidad se usan para presupuestar cuantos leads pedir, asi
// que donde hay dato real se usa el dato real. La deduccion se queda para
// los leads descartados antes de que existiera el catalogo.
const MOTIVO_A_CATEGORIA = {
  NUMERO_NO_EXISTE: "NO_EXISTE",
  NUMERO_EQUIVOCADO: "NO_EXISTE",
  NO_CONTESTO: "NO_CONTESTO",
};

function clasificarLead(lead, llamadas, umbralIntentos) {
  if (lead.status === "VENTA") return "CONCRETADA";
  if (lead.status === "REAGENDADO") return "REAGENDA";

  if (lead.motivoDescarte) {
    const directa = MOTIVO_A_CATEGORIA[lead.motivoDescarte];
    if (directa) return directa;
    // El resto de los motivos de proveedor (duplicado, fuera de cobertura,
    // nunca pidio informes) son basura igual, pero no de los dos tipos que
    // la grafica separa; y los de no-venta son descarte comercial.
    return "DESCARTADO_OTRO";
  }

  const { intentos = 0, contestadas = 0, inalcanzables = 0 } = llamadas || {};

  // Si llego a contestar alguna vez, el numero existia y si daba senal de
  // vida: lo que lo mato fue otra cosa.
  if (contestadas === 0) {
    if (inalcanzables > 0) return "NO_EXISTE";
    if (intentos >= umbralIntentos) return "NO_CONTESTO";
  }

  if (lead.status === "DESCARTADO") return "DESCARTADO_OTRO";

  // Nuevo y todavia sin agotar los intentos. No es basura ni es venta:
  // es trabajo pendiente, y mezclarlo con cualquiera de los dos miente.
  return "EN_PROCESO";
}

// Resume los intentos de cada lead en una sola fila por lead.
function resumirLlamadas(llamadas) {
  const porLead = new Map();
  for (const ll of llamadas) {
    let r = porLead.get(ll.leadId);
    if (!r) {
      r = { intentos: 0, contestadas: 0, inalcanzables: 0, primerContactoEn: null };
      porLead.set(ll.leadId, r);
    }
    r.intentos += 1;
    if (ll.contestada) {
      r.contestadas += 1;
      if (r.primerContactoEn === null) r.primerContactoEn = r.intentos;
    } else if (DESENLACE_INALCANZABLE.includes(ll.desenlace)) {
      r.inalcanzables += 1;
    }
  }
  return porLead;
}

function bucketVacio(extra = {}) {
  const base = Object.fromEntries(CATEGORIAS.map((c) => [c.clave, 0]));
  // `trash` y `noVendio` se cuentan aparte de las categorias: son la
  // pregunta de negocio, y no se pueden derivar de ellas.
  return { total: 0, trash: 0, noVendio: 0, conMotivo: 0, ...base, ...extra };
}

// `clasificacion` trae, ademas de la categoria de la grafica, si el lead
// fue basura por culpa del proveedor. Son dos ejes distintos: "numero no
// existe" y "no le interesa" son los dos un descarte, pero solo el primero
// significa que el proveedor cobro por algo que no era un lead.
function sumarA(bucket, clasificacion) {
  bucket.total += 1;
  bucket[clasificacion.categoria] += 1;
  if (clasificacion.motivoCapturado) bucket.conMotivo += 1;
  if (clasificacion.trash) bucket.trash += 1;
  else if (clasificacion.noVendio) bucket.noVendio += 1;
}

// Agrega los porcentajes y la tasa de aprovechamiento a un bucket ya
// contado. "Aprovechados" son los leads que siguen vivos o cerraron: lo
// contrario de la basura.
function cerrarBucket(bucket) {
  const pct = (n) => (bucket.total > 0 ? Math.round((n / bucket.total) * 100) : 0);
  const basura = bucket.NO_EXISTE + bucket.NO_CONTESTO + bucket.DESCARTADO_OTRO;
  return {
    ...bucket,
    porcentajes: Object.fromEntries(CATEGORIAS.map((c) => [c.clave, pct(bucket[c.clave])])),
    basura,
    porcentajeBasura: pct(basura),
    // --- Las dos cifras con las que se presupuesta ---
    //
    // `porcentajeTrash` es lo que el proveedor cobro y no era un lead.
    // `porcentajeCalidad` es su complemento: de cada cien que manda,
    // cuantos de verdad se pudieron trabajar. Con 20% de calidad, para 40
    // ventas hay que pedir 200 leads.
    //
    // Un "no le interesa" NO entra aqui: el lead era real y contesto. Si
    // contara como trash, el porcentaje saldria castigado y se pediria de
    // mas, que es el error que este corte existe para evitar.
    porcentajeTrash: pct(bucket.trash),
    porcentajeCalidad: bucket.total > 0 ? 100 - pct(bucket.trash) : 0,
    porcentajeNoVendio: pct(bucket.noVendio),
    // Que tan confiable es lo de arriba: los leads viejos no traen motivo
    // capturado y su clasificacion es deducida del historial de llamadas.
    porcentajeConMotivo: pct(bucket.conMotivo),
    // Concretadas sobre el total recibido.
    conversion: pct(bucket.CONCRETADA),
  };
}

// Toma los leads y las llamadas ya cargados y arma todos los cortes.
// `filtro` deja quedarse solo con un periodo sin volver a la base: dia y mes
// son subconjuntos del YTD, asi que una sola consulta alcanza para los tres.
function agregar(leads, resumenPorLead, umbralIntentos, filtro = () => true) {
  const total = bucketVacio();
  const porVendedor = new Map();
  const porCoordinador = new Map();
  const porOrigen = new Map();
  const porProducto = new Map();
  const porDia = new Map();
  // Cuantos leads se quedan en el intento 1, 2, 3+ sin que nadie conteste,
  // y en que intento se logro el contacto cuando se logro.
  const embudo = { sinLlamar: 0, muerenEn: {}, contactanEn: {} };

  const bucketDe = (mapa, clave, nombre) => {
    if (!mapa.has(clave)) mapa.set(clave, bucketVacio({ clave, nombre }));
    return mapa.get(clave);
  };

  for (const lead of leads) {
    if (!filtro(lead)) continue;

    const llamadas = resumenPorLead.get(lead.id);
    const categoria = clasificarLead(lead, llamadas, umbralIntentos);

    // El segundo eje: basura del proveedor o descarte comercial. Con motivo
    // capturado sale del catalogo; sin el, se infiere de la categoria --
    // "no existe" y "no contesto" son basura, el resto no se puede saber.
    const motivoCapturado = Boolean(lead.motivoDescarte);
    const trash = motivoCapturado
      ? esTrash(lead.motivoDescarte)
      : categoria === "NO_EXISTE" || categoria === "NO_CONTESTO";
    const noVendio = lead.status === "DESCARTADO" && !trash;
    const clasificacion = { categoria, trash, noVendio, motivoCapturado };

    sumarA(total, clasificacion);
    sumarA(bucketDe(porVendedor, lead.vendedorId ?? 0, lead.vendedor?.nombre ?? "Sin asignar"), clasificacion);
    // El reparto automatico no tiene coordinadora detras; mezclarlo con una
    // persona le acreditaria (o le cobraria) leads que no repartio.
    sumarA(bucketDe(porCoordinador, lead.asignadoPorId ?? 0, lead.asignadoPor?.nombre ?? "Reparto automatico"), clasificacion);
    sumarA(bucketDe(porOrigen, lead.source, lead.source === "EXTERNAL_API" ? "API externa" : "Captura manual"), clasificacion);
    sumarA(bucketDe(porProducto, lead.producto || "Sin producto", lead.producto || "Sin producto"), clasificacion);

    const dia = diaLocal(lead.createdAt);
    sumarA(bucketDe(porDia, dia, dia), clasificacion);

    const intentos = llamadas?.intentos ?? 0;
    if (intentos === 0) {
      embudo.sinLlamar += 1;
    } else if (llamadas.primerContactoEn) {
      const k = Math.min(llamadas.primerContactoEn, 4);
      embudo.contactanEn[k] = (embudo.contactanEn[k] || 0) + 1;
    } else {
      const k = Math.min(intentos, 4);
      embudo.muerenEn[k] = (embudo.muerenEn[k] || 0) + 1;
    }
  }

  const listar = (mapa, orden = (a, b) => b.total - a.total) =>
    Array.from(mapa.values()).map(cerrarBucket).sort(orden);

  return {
    resumen: cerrarBucket(total),
    porVendedor: listar(porVendedor),
    porCoordinador: listar(porCoordinador),
    porOrigen: listar(porOrigen),
    porProducto: listar(porProducto).slice(0, 10),
    serie: listar(porDia, (a, b) => a.clave.localeCompare(b.clave)),
    embudo,
  };
}

// Las horas se cuentan sobre las llamadas, no sobre los leads: la pregunta
// es a que hora conviene marcar, y eso solo lo contesta el intento.
function contarHoras(llamadas, desde) {
  const porHora = Array.from({ length: 24 }, (_, h) => ({ hora: h, intentos: 0, contestadas: 0 }));
  for (const ll of llamadas) {
    if (desde && ll.fecha < desde) continue;
    const h = porHora[horaLocal(ll.fecha)];
    h.intentos += 1;
    if (ll.contestada) h.contestadas += 1;
  }
  return porHora.map((h) => ({
    ...h,
    tasaContacto: h.intentos > 0 ? Math.round((h.contestadas / h.intentos) * 100) : 0,
  }));
}

async function umbralDeIntentos(tenantId) {
  const params = await getParametros(tenantId);
  return params.calidadIntentosNoContesto;
}

module.exports = {
  CATEGORIAS,
  DESENLACE_INALCANZABLE,
  clasificarLead,
  resumirLlamadas,
  agregar,
  contarHoras,
  umbralDeIntentos,
};
