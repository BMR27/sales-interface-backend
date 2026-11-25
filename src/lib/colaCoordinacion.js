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

// Las categorias (y sus reglas) viven en categoriaLead.js porque son
// generales: el administrador, la vendedora y los reportes las ven igual.
// Aqui solo se les agrega lo propio de la cola: la prioridad, el tono y la
// seccion "Ya asignados", que no es un estatus sino quien lo tiene.
const { CATEGORIA_POR_ID, esNuevoDeHoy, categoriaDe } = require("./categoriaLead");

const cat = (id, extra) => ({ ...CATEGORIA_POR_ID[id], ...extra });

// El orden es el que pidio operacion: Nuevos, Nuevos sin llamadas,
// Rellamadas, Reintentos, En hold y Descartados. `prioridad` es lo que se
// dibuja en la pastilla de la derecha de cada seccion.
const GRUPOS = [
  cat("nuevos", { prioridad: "Prioridad alta", tono: "nuevo" }),
  cat("pendientes_antiguos", { prioridad: "Prioridad alta", tono: "alta" }),
  cat("rellamadas", { prioridad: "Compromiso con el cliente", tono: "cita" }),
  cat("reintentos", { prioridad: "Prioridad estándar", tono: "estandar" }),
  cat("en_espera", { prioridad: "Bloqueados", tono: "espera" }),
  {
    id: "asignados",
    titulo: "Ya asignados",
    descripcion: "Leads que ya tienen vendedora trabajándolos.",
    prioridad: "En curso",
    tono: "asignado",
  },
  // Los cierres van hasta abajo: ya no son trabajo por repartir, pero
  // esconderlos obligaria a salir de la pantalla para consultarlos.
  cat("descartados", { prioridad: "Cerrados", tono: "descartado" }),
  cat("concretados", { prioridad: "Cerrados", tono: "concretado" }),
];

const POR_ID = Object.fromEntries(GRUPOS.map((g) => [g.id, g]));
const ORDEN = GRUPOS.map((g) => g.id);

// A que seccion de la cola pertenece un lead: su categoria general, salvo
// que una vendedora ya lo tenga abierto. Ahi la coordinadora no tiene nada
// que repartir y va a "Ya asignados".
//
// El estatus se revisa ANTES que la vendedora: un lead cerrado casi
// siempre conserva a quien lo cerro, y preguntar primero por `vendedorId`
// llenaba "Ya asignados" de leads terminados.
function grupoDe(lead, { intentos, ahora, hoy }) {
  const categoria = categoriaDe(lead, { intentos, ahora, hoy });
  if (categoria === "concretados" || categoria === "descartados") return categoria;
  if (lead.vendedorId) return "asignados";
  return categoria;
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
