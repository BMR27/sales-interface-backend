// El unico lugar donde un lead cambia de estatus.
//
// Antes esta logica vivia repartida en cinco endpoints -- descartar,
// devolver, supervision, reagendar y el webhook de Twilio -- y cada uno
// decidia por su cuenta que escribir. El resultado previsible: el mismo
// hecho producia estados distintos segun por donde entrara, y nadie podia
// decir con certeza que le pasaba a un lead al colgar. Un lead podia quedar
// DESCARTADO con una espera pendiente, o devuelto a la cola sin que el
// historial registrara el intento.
//
// La regla de oro del documento:
//
//   la vendedora registra el RESULTADO REAL de la llamada;
//   el sistema decide el ESTATUS y la siguiente accion;
//   la coordinadora administra las ASIGNACIONES.
//
// De ahi que aqui no haya ninguna funcion que reciba un estatus: se recibe
// lo que paso y se deriva lo demas. Ninguna pantalla puede escribir
// `status` a mano, y los procesos automaticos (el tick de las 72 horas, el
// webhook de Twilio) entran por estas mismas puertas.
//
// Todo lo que sale de aqui es ATOMICO: el lead, su historial de llamadas y
// su bitacora de asignaciones se escriben en una sola transaccion. Si una
// de las tres falla no se escribe ninguna. Un lead que cambia sin dejar
// rastro es un lead que nadie puede auditar, y el contador de intentos --
// del que depende el cierre de las 72 horas -- dejaria de ser confiable.
const prisma = require("./prisma");
const { getParametros } = require("./parametros");
const { emitir } = require("./eventos");
const { registrarResultado } = require("./historialLlamadas");
const {
  LEAD_STATUSES_ABIERTOS,
  esLeadAbierto,
} = require("./leadStatus");
const {
  EFECTO_COLA,
  EFECTO_TRASH,
  validarSeleccion,
} = require("./resultadosLlamada");
const {
  evaluarTurnoDe,
  siguienteInicioHabil,
  formatearMinuto,
} = require("./horariosVendedora");

// Cuanto vive un token de idempotencia. Cubre de sobra un doble clic o el
// reintento de un navegador que perdio la respuesta; mas alla de eso, una
// peticion con el mismo token ya no es un reintento sino otra cosa.
const IDEMPOTENCIA_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Idempotencia
// ---------------------------------------------------------------------------

// Ejecuta `fn` una sola vez por token.
//
// El doble clic en "Guardar resultado" contaba dos intentos, mandaba dos
// avisos y movia el lead dos veces. Validar en pantalla no alcanza: el
// navegador reintenta solo cuando la conexion se cae DESPUES de que el
// servidor ya escribio, y ahi no hay clic que deshabilitar.
//
// El candado es la clave primaria de `acciones_idempotentes`: el primer
// INSERT gana y los demas chocan. Al segundo se le devuelve la respuesta
// que recibio el primero, no un error -- desde fuera la accion si funciono,
// y mostrar un 409 por algo que salio bien es peor que no validar nada.
async function conIdempotencia(token, { accion, leadId, tenantId }, fn) {
  if (!token) return fn();

  try {
    await prisma.accionIdempotente.create({
      data: { token, accion, leadId: leadId ?? null, tenantId: tenantId ?? null },
    });
  } catch (err) {
    // P2002: ya existe. La accion corrio (o esta corriendo) con este token.
    if (err?.code !== "P2002") throw err;
    const previa = await prisma.accionIdempotente.findUnique({ where: { token } });
    return { ...(previa?.resultado ?? {}), repetida: true };
  }

  try {
    const resultado = await fn();
    // Se guarda para poder repetirla tal cual. Si falla el guardado, la
    // accion ya ocurrio: no se deshace por no haber podido memorizarla.
    await prisma.accionIdempotente
      .update({ where: { token }, data: { resultado } })
      .catch(() => {});
    return resultado;
  } catch (err) {
    // La accion fallo: el token se libera para que el reintento legitimo
    // pueda volver a intentarlo. Dejarlo puesto convertiria un error
    // transitorio en un bloqueo permanente de esa accion.
    await prisma.accionIdempotente.delete({ where: { token } }).catch(() => {});
    throw err;
  }
}

// Barre los tokens viejos. Lo llama el job de mantenimiento.
async function limpiarIdempotencia() {
  const { count } = await prisma.accionIdempotente.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - IDEMPOTENCIA_TTL_MS) } },
  });
  return count;
}

// ---------------------------------------------------------------------------
// Bitacora de asignaciones
// ---------------------------------------------------------------------------

// Una linea de `lead_asignaciones`. Siempre dentro de la transaccion de
// quien la provoca: el movimiento y su registro son el mismo hecho.
function registrarAsignacion(tx, {
  leadId,
  tenantId,
  actor,
  anterior,
  nuevo,
  evento,
  resultado,
  motivo,
  automatico = false,
}) {
  return tx.leadAsignacion.create({
    data: {
      leadId,
      tenantId,
      actorId: actor?.id ?? null,
      actorNombre: actor?.nombre ?? (automatico ? "Protocolo automático" : null),
      vendedorAnteriorId: anterior?.id ?? null,
      vendedorAnteriorNombre: anterior?.nombre ?? null,
      vendedorNuevoId: nuevo?.id ?? null,
      vendedorNuevoNombre: nuevo?.nombre ?? null,
      evento,
      resultado: resultado ?? null,
      motivo: motivo ?? null,
      automatico,
    },
  });
}

// ---------------------------------------------------------------------------
// Horario operativo de la empresa
// ---------------------------------------------------------------------------

// Cuando opera la empresa = cuando hay al menos una vendedora en turno.
//
// No se configura aparte a proposito: un horario de empresa que no cuadre
// con los turnos reales produciria leads "disponibles" a una hora en la que
// no hay nadie para llamarlos. Derivarlo de los turnos hace imposible esa
// contradiccion.
//
// Devuelve [] cuando nadie tiene turnos: entonces no hay horario que
// respetar y los intervalos corren a reloj corrido, que es como se comporto
// el sistema hasta ahora.
async function horarioOperativo(tenantId) {
  return prisma.horarioVendedora.findMany({
    where: { tenantId, user: { activo: true, rol: "VENDEDOR" } },
    select: { diaSemana: true, horaInicio: true, horaFin: true },
  });
}

// Corre un instante hasta la siguiente hora en que hay alguien trabajando.
//
// El documento es explicito: si la proxima disponibilidad cae fuera del
// horario operativo hay que MANTENER EL INTERVALO MINIMO y ademas mostrar
// el siguiente turno habil. Por eso esto no reemplaza `disponibleDesde`
// sino que lo acompaña: el candado se cumple igual, y aparte se dice desde
// cuando tiene sentido repartirlo.
function proximoHabil(horarios, fecha) {
  if (!horarios || horarios.length === 0) return null;
  const habil = siguienteInicioHabil(horarios, fecha);
  // Ya estaba en horario: no hay nada que explicar.
  if (!habil || habil.getTime() <= fecha.getTime()) return null;
  return habil;
}

// ---------------------------------------------------------------------------
// Resultado de llamada
// ---------------------------------------------------------------------------

// La transicion principal: la vendedora dice que paso y el sistema decide.
//
// `usuario` es quien registra (vendedora o coordinadora: las dos pueden
// llamar). Devuelve { lead, accion, ... } describiendo lo que ocurrio, para
// que la pantalla pueda explicarselo sin tener que deducirlo.
async function registrarResultadoLlamada({
  leadId,
  tenantId,
  usuario,
  resultado,
  submotivo,
  nota,
  // Cuando el resultado es "Número duplicado" y se pudo ubicar el registro
  // relacionado. Opcional: exigirlo bloquearia el cierre de duplicados que
  // la vendedora reconoce pero no puede rastrear.
  duplicadoDe,
  token,
  // true cuando lo decide una regla y no una persona: la red de seguridad
  // de src/jobs/resultadosPendientes.js, que tipifica con lo que reporto
  // Twilio las llamadas que nadie alcanzo a cerrar a mano. Cambia a quien
  // se le atribuye el movimiento -- culpar a la vendedora de algo que
  // decidio un reloj hace inservible la bitacora.
  automatico = false,
}) {
  const seleccion = validarSeleccion({ resultado, submotivo, nota });
  if (seleccion.error) return { error: seleccion.error, status: 400 };

  const { def, motivoDescarte, nota: notaLimpia } = seleccion;

  return conIdempotencia(token, { accion: `resultado:${def.clave}`, leadId, tenantId }, async () => {
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, tenantId },
      include: { vendedor: { select: { id: true, nombre: true } } },
    });
    if (!lead) return { error: "Lead no encontrado", status: 404 };

    // Un lead cerrado no es trabajo de nadie. Se valida AQUI y no solo en
    // pantalla: el documento lo pide expresamente, y es lo unico que
    // protege contra una pantalla vieja abierta en otra pestaña.
    if (!esLeadAbierto(lead.status)) {
      return {
        error:
          lead.status === "VENTA"
            ? "Este lead ya tiene una venta cerrada"
            : "Este lead ya está cerrado",
        status: 409,
      };
    }

    const params = await getParametros(tenantId);
    const ahora = new Date();

    const comun = {
      // El resultado tal cual lo vio la persona.
      substatus: def.clave,
      substatusAt: ahora,
      // El reloj de las 72 horas arranca con el primer intento. Si el
      // marcador ya lo puso, no se toca: el plazo no se reinicia.
      ...(lead.primeraLlamadaAt ? {} : { primeraLlamadaAt: ahora }),
      // Registrar un resultado cierra cualquier peticion de supervision
      // anterior: ya hay una respuesta.
      requiereSupervision: false,
      requiereRevisionHorario: false,
    };

    const salida =
      def.efecto === EFECTO_TRASH
        ? await aplicarTrash({ lead, def, motivoDescarte, nota: notaLimpia, duplicadoDe, usuario, tenantId, ahora, comun, automatico })
        : await aplicarVueltaACola({ lead, def, nota: notaLimpia, usuario, tenantId, params, ahora, comun, automatico });

    emitir(tenantId, salida.evento, {
      leadId,
      vendedorId: lead.vendedorId,
      resultado: def.clave,
      ...salida.payloadEvento,
    });

    return salida.respuesta;
  });
}

// Cierre definitivo. Hay una causa valida: numero inexistente, duplicado,
// blacklist, o el cliente dijo que no quiere comprar.
async function aplicarTrash({ lead, def, motivoDescarte, nota, duplicadoDe, usuario, tenantId, ahora, comun, automatico = false }) {
  // El duplicado se guarda en la nota y no en un campo propio: es
  // informativo, no una relacion de la que dependa nada, y un campo nuevo
  // obligaria a mantener la integridad de un dato que puede no existir.
  const notaFinal = duplicadoDe
    ? [nota, `Duplicado de ${String(duplicadoDe).trim().slice(0, 60)}`].filter(Boolean).join(" · ")
    : nota;

  const actualizado = await prisma.$transaction(async (tx) => {
    const actualizado = await tx.lead.update({
      where: { id: lead.id },
      data: {
        ...comun,
        status: "DESCARTADO",
        motivoDescarte,
        motivoDescarteNota: notaFinal,
        descartadoAt: ahora,
        // Un cierre automatico no tiene autor. Atribuirselo a la ultima
        // vendedora que marco seria culparla de una regla que no decidio.
        descartadoPorId: automatico ? null : usuario.id,
        ultimoDesenlace: null,
        // Un lead cerrado no espera nada ni tiene cita pendiente: dejar
        // estos relojes vivos lo haria reaparecer en los filtros de la cola.
        disponibleDesde: null,
        disponibleHasta: null,
        fechaReagenda: null,
        reagendaVendedorSugeridoId: null,
        reagendaAvisadaAt: null,
        seguimientoIncompleto: false,
        seguimientoIncompletoAt: null,
      },
    });

    await registrarResultado({
      leadId: lead.id,
      vendedorId: usuario.id,
      tenantId,
      resultado: def.clave,
      notas: notaFinal,
      estadoAntes: lead.status,
      estadoDespues: "DESCARTADO",
      // Solo "Cliente rechaza compra" prueba que hubo conversacion. Las
      // otras tres (no existe, duplicado, blacklist) se pueden determinar
      // sin que nadie conteste, y darlas por contestadas arruinaria el
      // unico numero que el historial existe para responder bien.
      implicaContacto: Boolean(def.implicaContacto),
      cliente: tx,
      propagarError: true,
    });

    await registrarAsignacion(tx, {
      leadId: lead.id,
      tenantId,
      actor: automatico ? null : usuario,
      anterior: lead.vendedor,
      nuevo: null,
      evento: "cerrada",
      resultado: def.clave,
      motivo: motivoDescarte,
      automatico,
    });

    return actualizado;
  });

  return {
    evento: "lead.descartado",
    payloadEvento: { motivo: motivoDescarte },
    respuesta: {
      lead: actualizado,
      accion: "descartado",
      resultado: def.clave,
      motivo: motivoDescarte,
      mensaje: `Lead cerrado como ${def.label.toLowerCase()}.`,
    },
  };
}

// Vuelta a la cola con candado. No hubo conversacion, asi que no hay nada
// que concluir: el lead espera su intervalo y vuelve a repartirse.
async function aplicarVueltaACola({ lead, def, nota, usuario, tenantId, params, ahora, comun, automatico = false }) {
  // La espera sale del catalogo del protocolo, no de un if aqui: ese
  // catalogo ya sabe que parametro corresponde a cada desenlace y con que
  // motivo se cierra al agotar el plazo. Duplicar el mapeo garantizaba que
  // tarde o temprano los dos dijeran cosas distintas.
  const { DESENLACES } = require("./protocoloLeads");
  const desenlace = DESENLACES[def.desenlace] ?? DESENLACES.NO_CONTESTA;
  const esperaMin = params[desenlace.esperaParam];

  const disponibleDesde = new Date(ahora.getTime() + esperaMin * 60000);
  const disponibleHasta = new Date(disponibleDesde.getTime() + params.ventanaReasignacionMin * 60000);

  // Si la disponibilidad cae cuando no hay nadie trabajando, el candado se
  // respeta igual (el intervalo minimo no se acorta ni se alarga) pero se
  // deja dicho desde cuando tiene sentido repartirlo. No se exige llamar
  // fuera de turno.
  const horarios = await horarioOperativo(tenantId);
  const habil = proximoHabil(horarios, disponibleDesde);

  const horas = Math.round((esperaMin / 60) * 10) / 10;
  const motivoDevolucion = [
    `${def.label}, vuelve en ${horas} h`,
    habil ? `fuera de horario operativo: se retoma el ${formatearFechaCorta(habil)}` : null,
    nota,
  ]
    .filter(Boolean)
    .join(" · ");

  const actualizado = await prisma.$transaction(async (tx) => {
    const actualizado = await tx.lead.update({
      where: { id: lead.id },
      data: {
        ...comun,
        // El estatus NO se mueve: el lead sigue abierto. Mandarlo a Trash
        // aqui es exactamente el descarte prematuro que este cambio existe
        // para impedir.
        vendedorId: null,
        asignadoAt: null,
        asignadoPorCoordinador: false,
        disponibleDesde,
        disponibleHasta,
        ultimoDesenlace: desenlace.clave,
        devueltoAt: ahora,
        devueltoMotivo: motivoDevolucion,
        devueltoPorNombre: automatico ? "Protocolo automático" : usuario.nombre ?? "Vendedora",
        // Una rellamada vigente se cancela: el cliente no contesto, asi que
        // la cita que habia pactado ya no describe la realidad.
        fechaReagenda: null,
        reagendaVendedorSugeridoId: null,
        reagendaAvisadaAt: null,
      },
    });

    await registrarResultado({
      leadId: lead.id,
      vendedorId: usuario.id,
      tenantId,
      resultado: def.clave,
      notas: nota,
      estadoAntes: lead.status,
      estadoDespues: actualizado.status,
      // Ninguno de los tres prueba contacto: son justo lo contrario.
      implicaContacto: false,
      cliente: tx,
      propagarError: true,
    });

    await registrarAsignacion(tx, {
      leadId: lead.id,
      tenantId,
      actor: automatico ? null : usuario,
      anterior: lead.vendedor,
      nuevo: null,
      evento: "devuelta",
      resultado: def.clave,
      motivo: motivoDevolucion,
      automatico,
    });

    return actualizado;
  });

  return {
    evento: "lead.devuelto",
    payloadEvento: { disponibleDesde },
    respuesta: {
      lead: actualizado,
      accion: "devuelto_a_cola",
      resultado: def.clave,
      disponibleDesde,
      disponibleHasta,
      proximoHabil: habil,
      mensaje: `${def.label}. Vuelve a la cola y se podrá repartir en ${horas} h.`,
    },
  };
}

function formatearFechaCorta(fecha) {
  return fecha.toLocaleString("es-MX", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Mexico_City",
  });
}

// ---------------------------------------------------------------------------
// Rellamar
// ---------------------------------------------------------------------------

// El cliente pidio que le llamen en otro momento.
//
// La regla completa del documento, en un solo lugar:
//
//   hoy  y DENTRO del turno de la vendedora -> se queda con ella
//   hoy  y FUERA de su turno                -> vuelve a la coordinadora
//   otro dia                                -> vuelve a la coordinadora
//   sin horario configurado                 -> vuelve, marcado para revisar
//
// En los tres casos que vuelven se conserva la hora pactada con el cliente
// y la identidad de quien genero la rellamada: la coordinadora puede
// reasignar con anticipacion, pero la cita no se mueve. Es el compromiso
// que se adquirio por telefono, no una preferencia interna.
async function programarRellamada({ leadId, tenantId, usuario, fecha, nota, token }) {
  const cuando = fecha ? new Date(fecha) : null;
  if (!cuando || Number.isNaN(cuando.getTime())) {
    return { error: "Fecha y hora de la rellamada requeridas", status: 400 };
  }

  return conIdempotencia(token, { accion: "rellamar", leadId, tenantId }, async () => {
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, tenantId },
      include: { vendedor: { select: { id: true, nombre: true } } },
    });
    if (!lead) return { error: "Lead no encontrado", status: 404 };

    if (!esLeadAbierto(lead.status)) {
      return {
        error:
          lead.status === "VENTA"
            ? "Este lead ya tiene una venta cerrada"
            : "Este lead ya está cerrado",
        status: 409,
      };
    }

    const params = await getParametros(tenantId);
    const ahora = new Date();

    // Un minuto de gracia: el reloj del navegador y el del servidor no son
    // el mismo, y rechazar por segundos una hora que la vendedora acaba de
    // elegir es un error que ella no puede corregir.
    if (cuando.getTime() < ahora.getTime() - 60000) {
      return { error: "La rellamada no puede quedar en el pasado", status: 400 };
    }

    // El limite se cuenta desde HOY, no desde la primera llamada: es lo que
    // se le promete al cliente en la llamada ("¿le marco el jueves?").
    const limite = new Date(ahora.getTime() + params.rellamarMaxDias * 86400000);
    if (cuando > limite) {
      return {
        error: `La rellamada no puede pasar de ${params.rellamarMaxDias} días (${formatearFechaCorta(limite)})`,
        status: 400,
        limite,
      };
    }

    const mismoDia = diaLocalDe(cuando) === diaLocalDe(ahora);

    // Quien genera la rellamada es quien esta hablando con el cliente. Si
    // la coordinadora registra por una vendedora, la vendedora del lead
    // sigue siendo la candidata natural: ya hablo con el cliente.
    const generadoraId = lead.vendedorId ?? usuario.id;
    const turno = mismoDia ? await evaluarTurnoDe(generadoraId, tenantId, cuando) : null;

    const sePuedeQuedar = mismoDia && turno?.configurado === true && turno.dentro === true;
    const sinHorario = mismoDia && turno?.configurado === false;

    const razon = !mismoDia
      ? "La rellamada es para otro día"
      : sinHorario
        ? "La vendedora no tiene horario configurado: hay que revisar su disponibilidad"
        : sePuedeQuedar
          ? null
          : turno?.motivo ?? "La hora queda fuera del turno de la vendedora";

    const actualizado = await prisma.$transaction(async (tx) => {
      const actualizado = await tx.lead.update({
        where: { id: lead.id },
        data: {
          status: "REAGENDADO",
          substatus: "RELLAMAR",
          substatusAt: ahora,
          fechaReagenda: cuando,
          // Quien genero la rellamada. La cola se lo propone a la
          // coordinadora con prioridad: ya hablo con el cliente y sabe de
          // que se trata. Es una sugerencia, no una obligacion.
          reagendaVendedorSugeridoId: generadoraId,
          reagendaAvisadaAt: null,
          ...(lead.primeraLlamadaAt ? {} : { primeraLlamadaAt: ahora }),
          // La espera del protocolo no aplica: aqui el cliente SI contesto
          // y pidio algo concreto. Lo que manda es la hora pactada.
          disponibleDesde: null,
          disponibleHasta: null,
          ultimoDesenlace: null,
          // Una cita viva protege al lead del cierre por plazo (ver
          // cierrePorPlazo.js): cerrarlo seria incumplir lo que se prometio.
          seguimientoIncompleto: false,
          seguimientoIncompletoAt: null,
          requiereRevisionHorario: sinHorario,
          ...(sePuedeQuedar
            ? {
                // Se queda con ella. No se toca `asignadoAt`: sigue siendo
                // el mismo trabajo del mismo dia.
                requiereSupervision: false,
              }
            : {
                vendedorId: null,
                asignadoAt: null,
                asignadoPorCoordinador: false,
                requiereSupervision: true,
                supervisionNota: [razon, nota].filter(Boolean).join(" · ").slice(0, 300),
                supervisionPedidaAt: ahora,
                devueltoAt: ahora,
                devueltoMotivo: `Rellamada ${formatearFechaCorta(cuando)} — ${razon}`.slice(0, 300),
                devueltoPorNombre: usuario.nombre ?? "Vendedora",
              }),
        },
      });

      await registrarResultado({
        leadId: lead.id,
        vendedorId: usuario.id,
        tenantId,
        resultado: "RELLAMAR",
        notas: [nota, razon].filter(Boolean).join(" · ") || null,
        estadoAntes: lead.status,
        estadoDespues: "REAGENDADO",
        // Pedir una rellamada exige que el cliente haya contestado: nadie
        // pide una hora sin hablar.
        implicaContacto: true,
        cliente: tx,
        propagarError: true,
      });

      await registrarAsignacion(tx, {
        leadId: lead.id,
        tenantId,
        actor: usuario,
        anterior: lead.vendedor,
        nuevo: sePuedeQuedar ? lead.vendedor : null,
        evento: "rellamada",
        resultado: "RELLAMAR",
        motivo: razon,
      });

      return actualizado;
    });

    emitir(tenantId, sePuedeQuedar ? "lead.reagendado" : "lead.supervision", {
      leadId,
      vendedorId: lead.vendedorId,
      fechaReagenda: cuando,
    });

    return {
      lead: actualizado,
      accion: sePuedeQuedar ? "rellamada_propia" : "rellamada_a_coordinadora",
      fechaReagenda: cuando,
      sinHorario,
      razon,
      mensaje: sePuedeQuedar
        ? `Rellamada agendada para el ${formatearFechaCorta(cuando)}. El lead se queda contigo.`
        : `Rellamada agendada para el ${formatearFechaCorta(cuando)}. ${razon}: pasa a la coordinadora.`,
    };
  });
}

// El dia de calendario de un instante, visto desde la operacion. Se importa
// aqui abajo y no arriba para no crear un ciclo con fechasLocales.
function diaLocalDe(fecha) {
  return require("./fechasLocales").diaLocal(fecha);
}

module.exports = {
  conIdempotencia,
  limpiarIdempotencia,
  registrarAsignacion,
  horarioOperativo,
  proximoHabil,
  registrarResultadoLlamada,
  programarRellamada,
  LEAD_STATUSES_ABIERTOS,
};
