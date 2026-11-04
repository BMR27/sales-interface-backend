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
const { getParametros } = require("./parametros");
const { LEAD_STATUSES_ABIERTOS } = require("./leadStatus");
const { emitir } = require("./eventos");
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

// Un lead entra al cierre automatico solo si nacio despues del corte.
function entraAlProtocolo(lead) {
  return !!lead.createdAt && lead.createdAt >= PROTOCOLO_DESDE;
}

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

// Se ejecuta al terminar una llamada que nadie contesto. Nunca lanza: va
// colgado del webhook de Twilio, y un fallo aqui no puede tumbar el aviso
// de fin de llamada ni dejar la llamada a medias.
async function aplicarProtocoloNoContesto({ leadId, tenantId, desenlaceTwilio }) {
  try {
    if (!leadId || !tenantId) return null;

    const params = await getParametros(tenantId);
    if (!params.reintentoAutomatico) return null;

    const lead = await prisma.lead.findFirst({
      where: { id: leadId, tenantId },
      select: {
        id: true, status: true, vendedorId: true, createdAt: true,
        reintentosDesde: true, primeraLlamadaAt: true,
      },
    });
    // Un lead ya cerrado -- vendido o descartado -- no es trabajo de nadie.
    if (!lead || !LEAD_STATUSES_ABIERTOS.includes(lead.status)) return null;

    // Un lead reactivado empieza de cero: si contaramos desde su primera
    // llamada historica, ya habria agotado las 72 horas y se descartaria
    // en el primer intento.
    const inicioDelPlazo = lead.reintentosDesde ?? lead.primeraLlamadaAt ?? new Date();

    const contestadas = await prisma.llamada.count({
      where: {
        leadId, tenantId, contestada: true,
        ...(lead.reintentosDesde ? { fecha: { gte: lead.reintentosDesde } } : {}),
      },
    });
    // Si alguna vez contesto, el numero servia y la conversacion existio:
    // este protocolo no aplica. Lo que siga lo decide quien lo atienda.
    if (contestadas > 0) return null;

    const desenlace = clasificarDesenlace(desenlaceTwilio);
    const ahora = new Date();
    const vencePlazo = new Date(inicioDelPlazo.getTime() + params.horasParaTrash * 3600000);

    if (ahora >= vencePlazo && entraAlProtocolo(lead)) {
      await descartarPorPlazo(lead.id, desenlace);
      emitir(tenantId, "lead.descartado", { leadId, motivo: desenlace.motivoTrash });
      return { accion: "descartado", desenlace: desenlace.clave, motivo: desenlace.motivoTrash };
    }

    const esperaMin = params[desenlace.esperaParam];
    const disponibleDesde = new Date(ahora.getTime() + esperaMin * 60000);
    const disponibleHasta = new Date(
      disponibleDesde.getTime() + params.ventanaReasignacionMin * 60000
    );

    await prisma.lead.update({
      where: { id: leadId },
      data: {
        vendedorId: null,
        asignadoAt: null,
        asignadoPorCoordinador: false,
        disponibleDesde,
        disponibleHasta,
        ultimoDesenlace: desenlace.clave,
        // El reloj de las 72 horas arranca con el primer intento y no se
        // vuelve a tocar.
        ...(lead.primeraLlamadaAt ? {} : { primeraLlamadaAt: ahora }),
        devueltoAt: ahora,
        devueltoMotivo: etiquetaDeEspera(desenlace, esperaMin),
        devueltoPorNombre: "Protocolo automatico",
      },
    });

    // La vendedora que acaba de marcar tiene la pantalla abierta con este
    // lead y un boton de llamar que ya no va a funcionar: el lead dejo de
    // ser suyo en este mismo instante. El aviso hace que su lista se
    // actualice sola en vez de dejarla descubrirlo al siguiente intento.
    emitir(tenantId, "lead.devuelto", {
      leadId,
      vendedorId: lead.vendedorId,
      motivo: desenlace.clave,
      disponibleDesde,
    });

    return {
      accion: "reencolado",
      desenlace: desenlace.clave,
      esperaMinutos: esperaMin,
      disponibleDesde,
      disponibleHasta,
      vencePlazo,
    };
  } catch (err) {
    console.error("no se pudo aplicar el protocolo de no contesto", leadId, err);
    return null;
  }
}

function etiquetaDeEspera(desenlace, esperaMin) {
  const horas = Math.round((esperaMin / 60) * 10) / 10;
  if (desenlace.clave === "RECHAZA") return `Rechazó la llamada, vuelve en ${horas} h`;
  if (desenlace.clave === "FUERA_DE_SERVICIO") return `Número fuera de servicio, vuelve en ${horas} h`;
  return `No contestó, vuelve en ${horas} h`;
}

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

// Nombre anterior, conservado porque lo importan el job de cierre y los
// scripts de mantenimiento. Apunta al mismo cierre.
const descartarPorPlazo = cerrarPorProtocolo;

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
  entraAlProtocolo,
  aplicarProtocoloNoContesto,
  filtroDisponible,
  filtroVentanaVencida,
  descartarPorPlazo,
  cerrarPorProtocolo,
  evaluarSeguimiento,
  clasificarDesenlace,
  DESENLACES,
};
