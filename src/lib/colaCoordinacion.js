// Como se ordena y se agrupa la cola de la coordinadora.
//
// La cola era una lista plana ordenada por fecha de entrada. Con 60 leads
// en pantalla eso no es una cola de trabajo: es un volcado. Lo que la
// coordinadora necesita decidir en cada momento es cual repartir PRIMERO, y
// esa respuesta no sale de la fecha sino de tres preguntas en este orden:
//
//   1. ¿Hay leads que entraron hoy y siguen intactos? -- son los frescos
//   2. ¿Hay leads viejos que nadie ha llamado nunca?  -- se estan perdiendo
//   3. ¿Hay reintentos cuya espera ya termino?        -- toca insistir
//
// Los NUEVOS van primero por decision de operacion: un lead recien captado
// se contacta mejor mientras el cliente todavia recuerda haber dejado sus
// datos, y esa ventana se cierra en horas. Antes encabezaban los
// pendientes antiguos; la contrapartida de este orden es que un lead viejo
// sin llamadas puede quedar debajo de una tanda de frescos, asi que sigue
// en segundo lugar -- por encima de todo lo demas -- y la pestaña
// "Atrasados" lo sigue sacando aparte.
//
// Dentro de cada grupo, del mas antiguo al mas reciente: el que lleva mas
// tiempo esperando es el que menos tiempo le queda.
//
// Los dos grupos que NO compiten por el primer lugar pero no pueden
// esconderse:
//
//   en espera   rebotaron y todavia cumplen su candado. Se ven, pero
//               aparte: mezclarlos con los disponibles haria que la
//               coordinadora intentara repartir leads que el protocolo
//               bloquea, y esconderlos hacia que parecieran perdidos.
//   rellamadas  tienen hora pactada con el cliente. Van en su propia
//               alerta, ordenadas por esa hora: una rellamada vencida es
//               un compromiso incumplido, no un lead mas en la fila.
//
// Y al final, lo que ya no es trabajo: los concretados y los descartados.
// Iban mezclados en "Ya asignados" -- cualquier lead con vendedora caia
// ahi, sin mirar su estatus -- asi que esa seccion mostraba 493 leads
// cerrados junto a los que de verdad se estan trabajando. Se separan
// porque son preguntas distintas: "quien esta atendiendo esto" no es
// "esto ya se acabo".
const { diaLocal } = require("./fechasLocales");

// El orden es el del documento. `prioridad` es lo que se dibuja en la
// pastilla de la derecha de cada seccion.
const GRUPOS = [
  {
    id: "nuevos",
    titulo: "Nuevos leads",
    descripcion: "Leads recién captados, listos para asignar y contactar.",
    prioridad: "Prioridad alta",
    tono: "media",
  },
  {
    id: "pendientes_antiguos",
    titulo: "Pendientes antiguos, sin llamadas",
    descripcion: "Leads que llevan más tiempo esperando y no tienen llamadas registradas.",
    prioridad: "Prioridad alta",
    tono: "alta",
  },
  {
    id: "reintentos",
    titulo: "Reintentos",
    descripcion: "Leads a los que ya se intentó contactar y requieren un nuevo intento.",
    prioridad: "Prioridad estándar",
    tono: "estandar",
  },
  {
    id: "rellamadas",
    titulo: "Rellamadas agendadas",
    descripcion: "El cliente pidió una hora concreta. Atiéndelas antes de que venzan.",
    prioridad: "Compromiso con el cliente",
    tono: "cita",
  },
  {
    id: "en_espera",
    titulo: "En espera",
    descripcion: "Devueltos por el protocolo. Todavía cumplen su intervalo y no se pueden repartir.",
    prioridad: "Bloqueados",
    tono: "espera",
  },
  {
    id: "asignados",
    titulo: "Ya asignados",
    descripcion: "Leads que ya tienen vendedora trabajándolos.",
    prioridad: "En curso",
    tono: "asignado",
  },
  // Los dos cierres van hasta abajo: ya no son trabajo por repartir, pero
  // esconderlos obligaria a salir de la pantalla para consultarlos.
  {
    id: "concretados",
    titulo: "Concretados",
    descripcion: "Terminaron en venta. Se muestran al final: ya no hay nada que repartir.",
    prioridad: "Cerrados",
    tono: "concretado",
  },
  {
    id: "descartados",
    titulo: "Descartados",
    descripcion: "Se cerraron sin venta, por descarte o por agotarse el protocolo.",
    prioridad: "Cerrados",
    tono: "descartado",
  },
];

const POR_ID = Object.fromEntries(GRUPOS.map((g) => [g.id, g]));
const ORDEN = GRUPOS.map((g) => g.id);

// ¿Es un lead NEW?
//
// La regla del documento, literal: entro HOY y todavia no tiene intentos.
// Las dos condiciones importan. Solo por la fecha, un lead de hoy al que ya
// se le marco tres veces seguiria luciendo intacto; solo por los intentos,
// un lead de hace una semana que nadie toco se mostraria como recien
// llegado y competiria con los frescos por la atencion. Al cambiar de dia o
// al registrar la primera llamada, el distintivo se retira solo.
function esNuevoDeHoy(lead, intentos, hoy) {
  return intentos === 0 && diaLocal(lead.createdAt) === hoy;
}

// A que seccion pertenece un lead.
//
// `ahora` y `hoy` se pasan desde fuera para que todos los leads de una
// misma respuesta se clasifiquen contra el mismo instante: calculado por
// lead, un lote que tarde en procesarse podria partir el dia a la mitad.
function grupoDe(lead, { intentos, ahora, hoy }) {
  // El estatus se revisa ANTES que la vendedora. Un lead cerrado casi
  // siempre conserva la vendedora que lo cerro, asi que preguntar primero
  // por `vendedorId` lo mandaba a "Ya asignados" y esa seccion acababa
  // llena de leads terminados.
  if (lead.status === "VENTA") return "concretados";
  if (lead.status === "DESCARTADO" || lead.status === "NO_CONCRETADO") return "descartados";

  if (lead.vendedorId) return "asignados";

  // Una cita pactada manda sobre todo lo demas: es lo unico de esta lista
  // que se le prometio a un cliente por telefono.
  if (lead.status === "REAGENDADO" && lead.fechaReagenda) return "rellamadas";

  if (lead.disponibleDesde && lead.disponibleDesde > ahora) return "en_espera";

  if (intentos > 0) return "reintentos";

  return esNuevoDeHoy(lead, intentos, hoy) ? "nuevos" : "pendientes_antiguos";
}

// El orden DENTRO de cada grupo.
//
// Casi siempre "del mas antiguo al mas reciente", porque el que lleva mas
// esperando es el que menos vida le queda. Las dos excepciones:
//
//   rellamadas  por la hora pactada: lo que importa es a quien hay que
//               llamar antes, no quien entro primero al sistema.
//   en espera   por cuando se desbloquean, que es el orden en que la
//               coordinadora los va a poder repartir.
function comparadorDe(grupoId) {
  if (grupoId === "rellamadas") {
    return (a, b) => fecha(a.fechaReagenda) - fecha(b.fechaReagenda);
  }
  if (grupoId === "en_espera") {
    return (a, b) => fecha(a.disponibleDesde) - fecha(b.disponibleDesde);
  }
  // En los cierres se invierte: lo mas reciente arriba. Aqui ya no se
  // reparte nada, se consulta -- y lo que se consulta es lo que acaba de
  // pasar, no lo de hace tres semanas.
  if (grupoId === "descartados" || grupoId === "concretados") {
    return (a, b) => fecha(b.descartadoAt ?? b.updatedAt ?? b.createdAt) -
                     fecha(a.descartadoAt ?? a.updatedAt ?? a.createdAt);
  }
  return (a, b) => fecha(a.createdAt) - fecha(b.createdAt);
}

function fecha(v) {
  return v ? new Date(v).getTime() : Number.MAX_SAFE_INTEGER;
}

// Reparte los leads ya enriquecidos en sus secciones, en el orden del
// documento. Las secciones vacias no se devuelven: un encabezado con cero
// leads es ruido que empuja hacia abajo lo que si hay que atender.
function agrupar(leads) {
  const porGrupo = new Map();
  for (const lead of leads) {
    if (!porGrupo.has(lead.grupo)) porGrupo.set(lead.grupo, []);
    porGrupo.get(lead.grupo).push(lead);
  }

  return ORDEN.filter((id) => porGrupo.has(id)).map((id) => {
    const items = porGrupo.get(id).sort(comparadorDe(id));
    return { ...POR_ID[id], total: items.length, leadIds: items.map((l) => l.id) };
  });
}

// ¿Este lead está atrasado?
//
// Dos cosas distintas que la coordinadora necesita ver juntas porque las
// dos significan "esto ya debio haberse hecho":
//
//   ventana vencida        el lead lleva disponible mas de su ventana de
//                          reparto y nadie lo asigno. NO esta bloqueado --
//                          bloquearlo lo dejaria inalcanzable si nadie
//                          entra a tiempo -- pero hay que avisarlo.
//   seguimiento incompleto se vencieron las 72 horas sin los intentos que
//                          tocaban. El lead sigue abierto a proposito:
//                          cerrarlo seria descartar una oportunidad que
//                          nadie trabajo.
function motivoDeAtraso(lead, { ahora, alertaAtrasoMin }) {
  if (lead.seguimientoIncompleto) {
    return {
      clave: "seguimiento_incompleto",
      titulo: "Seguimiento incompleto — No puede cerrarse automáticamente",
      detalle:
        lead.intentosEsperados != null && lead.intentosRealizados != null
          ? `Faltan intentos del protocolo (${lead.intentosRealizados} de ${lead.intentosEsperados}). Permanece pendiente y se marca como Atrasado.`
          : "Faltan intentos del protocolo. Permanece pendiente y se marca como Atrasado.",
    };
  }

  // La alerta no salta al cerrarse la ventana sino un rato despues: el
  // documento da ese margen ("si pasan 15 minutos adicionales sin
  // asignacion"). Avisar en el minuto exacto convertiria en urgencia algo
  // que todavia se puede atender con calma.
  if (lead.disponibleHasta && !lead.vendedorId) {
    const limite = new Date(lead.disponibleHasta.getTime() + alertaAtrasoMin * 60000);
    if (limite < ahora) {
      return {
        clave: "ventana_vencida",
        titulo: "Fuera de su ventana de reparto — repartir cuanto antes",
        detalle: "Terminó el intervalo en el que tocaba reasignarlo. Sigue siendo asignable.",
      };
    }
  }

  return null;
}

module.exports = { GRUPOS, ORDEN, POR_ID, esNuevoDeHoy, grupoDe, agrupar, motivoDeAtraso, comparadorDe };
