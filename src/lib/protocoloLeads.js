// Secuencialidad de una llamada cuando el cliente NO contesta.
//
// La regla de negocio (documento "Secuencialidad de una llamada, en
// sistema"): un lead que no contesta no se descarta, vuelve al queue de la
// coordinadora con un candado que depende de COMO termino la llamada, y se
// insiste asi hasta 72 horas contadas desde la PRIMERA llamada. Agotado el
// plazo, se descarta solo como trash con la justificacion que corresponde.
//
//   desenlace            candado        trash a las 72h
//   no contesta/buzon    2:00 - 2:15    "no contesto despues de 72 horas"
//   rechaza la llamada   3:00 - 3:15    "rechazo las llamadas despues de 72 horas"
//   fuera de servicio    4:00 - 4:15    "numero fuera de servicio despues de 72 horas"
//
// El cuarto de hora de arriba es una ventana, no un vencimiento: pasada
// esa hora el lead sigue repartible, pero `disponibleHasta` ya vencio y la
// coordinadora puede verlo como atrasado. Bloquearlo de verdad dejaria
// leads inalcanzables si nadie entra justo en esos 15 minutos.
//
// Lo que sustituye: antes esto se media en intentos (3 intentos, 90
// minutos fijos entre uno y otro) sin importar como habia terminado la
// llamada ni cuanto llevaba el lead en la cola.
const prisma = require("./prisma");
const { siguienteInicioHabil } = require("./horariosVendedora");

// Desde cuando aplica el descarte automatico por agotar el plazo.
//
// El protocolo entro en vigor con los leads del 1 de noviembre de 2026 en
// adelante. Sin esta linea, al encenderlo todos los leads viejos -- que
// llevan semanas en la cola -- superarian las 72 horas de golpe y el
// sistema los descartaria en masa el dia del despliegue: una limpieza que
// nadie pidio y que no se puede deshacer lead por lead.
//
// Por que el 1 y no una fecha anterior: un lead no se cierra por su edad
// sino porque su PRIMERA llamada tiene mas de 72 horas, y esa llamada
// nunca es anterior a su creacion. Con el corte en el 1 de noviembre, el
// lead mas viejo que entra no puede vencer antes del 4: no hay cierre
// masivo posible el dia del despliegue, solo vencimientos escalonados
// como en la operacion normal.
//
// Los leads anteriores siguen trabajandose a mano como hasta ahora; lo que
// no hace el sistema es cerrarlos solo. Las esperas entre intentos si
// aplican a todos: esas no destruyen nada.
const PROTOCOLO_DESDE = new Date("2026-11-01T00:00:00-06:00");

// Como termino el intento, en los terminos del protocolo.
//
// Twilio no distingue "el cliente colgo" de "el telefono comunicaba": las
// dos llegan como `busy`. Es lo mas cerca que se puede estar de la
// clasificacion del documento sin preguntarle a la vendedora.
const DESENLACES = {
  NO_CONTESTA: {
    clave: "NO_CONTESTA",
    // no-answer: sonaron los rings y nadie contesto. El buzon tambien cae
    // aqui cuando la llamada se corta sin que nadie descuelgue.
    twilio: ["no-answer"],
    esperaParam: "esperaNoContestaMin",
    motivoTrash: "NO_CONTESTO_72H",
    justificacion: "Cliente no contestó después de 72 horas en queue",
  },
  RECHAZA: {
    clave: "RECHAZA",
    // busy: comunicando o rechazo explicito del cliente.
    twilio: ["busy"],
    esperaParam: "esperaRechazaMin",
    motivoTrash: "RECHAZO_72H",
    justificacion: "Cliente rechazó las llamadas después de 72 horas en queue",
  },
  FUERA_DE_SERVICIO: {
    clave: "FUERA_DE_SERVICIO",
    // failed/canceled: la red no pudo alcanzar el numero -- temporalmente
    // fuera de servicio, fuera del area de cobertura.
    twilio: ["failed", "canceled"],
    esperaParam: "esperaFueraServicioMin",
    motivoTrash: "FUERA_SERVICIO_72H",
    justificacion: "Número de cliente FUERA DE SERVICIO después de 72 horas en queue",
  },
};

function clasificarDesenlace(desenlaceTwilio) {
  for (const d of Object.values(DESENLACES)) {
    if (d.twilio.includes(desenlaceTwilio)) return d;
  }
  // Desconocido o sin dato: se trata como "no contesta", que es el candado
  // mas corto. Esperar de mas castiga al lead por una falta de informacion
  // que no es suya.
  return DESENLACES.NO_CONTESTA;
}

// Aqui vivia `aplicarProtocoloNoContesto`, que movia el lead desde el
// webhook de Twilio en cuanto la llamada terminaba sin respuesta.
//
// Se retiro, no se desactivo. Hacia dos cosas que el protocolo nuevo ya no
// admite: clasificaba el desenlace a partir del codigo de Twilio -- que no
// distingue "el cliente colgo" de "el telefono comunicaba" -- y cerraba el
// lead al vencer las 72 horas sin comprobar que se hubieran hecho los
// intentos que tocaban.
//
// Dejarlo como codigo muerto era peor que borrarlo: es una segunda puerta
// al mismo cambio de estatus, sin transaccion, sin bitacora de asignaciones
// y sin la validacion de evidencia. Quien la reconectara por descuido
// volveria a producir los descartes prematuros que este rediseño corrige.
//
// Lo que hace ahora lo mismo, con todas las reglas en un solo lugar:
//   src/lib/cicloLead.js          la vendedora registra el resultado
//   src/jobs/resultadosPendientes.js  la red para quien no lo registra
//   src/jobs/cierrePorPlazo.js    el cierre de las 72 horas, con evidencia

// El cierre de las 72 horas.
//
// Da NO_CONCRETADO, no DESCARTADO. La diferencia no es cosmetica: aqui el
// lead era legitimo y se agoto el protocolo sin contacto efectivo, mientras
// que DESCARTADO significa que existe una causa valida de descarte
// (inexistente, duplicado, el cliente dijo que no). Mezclarlos castigaba el
// porcentaje de calidad de la base con leads que solo no contestaron, y
// hacia que CF recibiera como trash algo que nunca lo fue.
//
// El motivo de cierre si se conserva (`motivoDescarte`), porque el
// documento pide registrar la causa de no contacto.
async function cerrarPorProtocolo(leadId, desenlace, { intentosEsperados, intentosRealizados } = {}) {
  await prisma.lead.update({
    where: { id: leadId },
    data: {
      status: "NO_CONCRETADO",
      motivoDescarte: desenlace.motivoTrash,
      motivoDescarteNota: desenlace.justificacion,
      descartadoAt: new Date(),
      // Sin `descartadoPorId`: no lo cerro una persona, lo cerro el
      // protocolo. Atribuirselo a la ultima vendedora que marco seria
      // culparla de una regla que no decidio.
      disponibleDesde: null,
      disponibleHasta: null,
      requiereSupervision: false,
      seguimientoIncompleto: false,
      seguimientoIncompletoAt: null,
      ...(Number.isFinite(intentosEsperados) ? { intentosEsperados } : {}),
      ...(Number.isFinite(intentosRealizados) ? { intentosRealizados } : {}),
    },
  });
}

// ¿Se hicieron los intentos que tocaban?
//
// Esta es la validacion critica del documento: "no es suficiente que hayan
// transcurrido 72 horas, debe existir evidencia de los intentos
// correspondientes". Sin ella el sistema cerraba por reloj leads que nadie
// habia trabajado -- exactamente la oportunidad perdida que el plazo
// pretendia evitar.
//
// Como se mide, sin inventar un numero fijo de llamadas (el documento lo
// prohibe expresamente, porque los horarios y los resultados generan
// intervalos distintos):
//
//   cada intento define CUANDO tocaba el siguiente -- su propia espera
//   (2 h, 3 h o 4 h segun como termino), corrida hasta la proxima hora
//   habil. Si ese momento ya paso y no hay un intento despues de el, se
//   quedo a deber una llamada.
//
// Asi, un lead con una sola llamada en 72 horas sale incompleto (debia
// haber varias), y uno al que se le insistio en cada ventana sale completo
// aunque tenga menos intentos porque la mitad del plazo cayo en domingo.
function evaluarSeguimiento({ llamadas, params, horarios, hasta = new Date() }) {
  const intentos = (llamadas || [])
    .slice()
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  // Sin un solo intento no hay plazo que evaluar: las 72 horas ni siquiera
  // arrancaron (arrancan con la PRIMERA llamada, no con el ingreso).
  if (intentos.length === 0) {
    return { completo: false, intentosEsperados: 1, intentosRealizados: 0, sinIntentos: true };
  }

  const ultimo = intentos[intentos.length - 1];
  const desenlace = DESENLACES[ultimo.desenlaceProtocolo] ?? DESENLACES.NO_CONTESTA;
  const esperaMs = params[desenlace.esperaParam] * 60000;

  let vencia = new Date(new Date(ultimo.fecha).getTime() + esperaMs);
  // No se le exige a nadie llamar fuera de turno: si el siguiente intento
  // caia de madrugada, lo que tocaba era hacerlo al abrir.
  if (horarios && horarios.length > 0) {
    const habil = siguienteInicioHabil(horarios, vencia);
    if (habil && habil > vencia) vencia = habil;
  }

  // Quedaba una llamada por hacer y el plazo se acabo antes de que se
  // hiciera: el seguimiento esta incompleto.
  const debiaOtro = vencia <= hasta;

  return {
    completo: !debiaOtro,
    // "Esperados" es lo realmente hecho mas la que se quedo a deber: es el
    // numero que la coordinadora necesita para entender el atraso.
    intentosEsperados: intentos.length + (debiaOtro ? 1 : 0),
    intentosRealizados: intentos.length,
    proximoIntentoVencia: debiaOtro ? vencia : null,
  };
}

// Filtro de Prisma para "se puede repartir ahora": o nunca estuvo en
// espera, o la espera ya paso. Se usa en la cola del coordinador y en el
// reparto automatico, que si no entregarian leads que acaban de rebotar.
function filtroDisponible() {
  return {
    OR: [{ disponibleDesde: null }, { disponibleDesde: { lte: new Date() } }],
  };
}

// Los que ya pasaron su ventana de 15 minutos sin que nadie los repartiera.
// No estan bloqueados -- siguen en la cola -- pero el protocolo pedia
// avisar, y esto es lo que permite marcarlos en pantalla.
function filtroVentanaVencida() {
  return { disponibleHasta: { lt: new Date() } };
}

module.exports = {
  PROTOCOLO_DESDE,
  filtroDisponible,
  cerrarPorProtocolo,
  evaluarSeguimiento,
  clasificarDesenlace,
  DESENLACES,
};
