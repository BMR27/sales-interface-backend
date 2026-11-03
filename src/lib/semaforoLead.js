// El estado de un lead de un vistazo, con sus relojes.
//
// En una operacion de venta por telefono cada lead cuesta dinero y tiene
// fecha de caducidad: se compro, se puede trabajar durante 72 horas y si
// nadie lo atiende a tiempo se pierde. Quien reparte necesita ver, sin
// abrir nada, cuales no ha tocado nadie, cuales ya rebotaron, cuanto falta
// para poder volver a marcarles y cuanto les queda de vida.
//
// Vive en un solo lugar porque lo usan la cola de la coordinadora, la
// pantalla del administrador y la de la vendedora. Con el calculo repetido
// en cada una, el mismo lead acabaria pintado de dos colores distintos
// segun quien lo mire.
const { getParametros } = require("./parametros");

// Lo que la pantalla necesita incluir para que esto funcione.
const SELECT_SEMAFORO = {
  status: true,
  vendedorId: true,
  asignadoAt: true,
  createdAt: true,
  disponibleDesde: true,
  disponibleHasta: true,
  primeraLlamadaAt: true,
  reintentosDesde: true,
  ultimoDesenlace: true,
  fechaReagenda: true,
  motivoDescarte: true,
};

// verde   nadie le ha marcado nunca: el lead esta intacto
// ambar   ya se gestiono y sigue vivo
// rojo    descartado
//
// La venta cerrada no entra en el semaforo de trabajo: ya no es algo que
// alguien tenga que atender. Se devuelve como "vendido" para que la
// pantalla la distinga de un lead en proceso.
function colorDe(lead, intentos) {
  if (lead.status === "DESCARTADO") return "trash";
  if (lead.status === "VENTA") return "vendido";
  if (intentos === 0) return "nuevo";
  return "trabajado";
}

// Todos los relojes del lead, en milisegundos desde ahora. Negativo
// significa que ya paso.
//
// Se mandan como fechas absolutas y no como texto ("en 2 horas") a
// proposito: el texto se congela en el momento en que se genera la
// respuesta, y esta pantalla se queda abierta. El contador lo corre el
// navegador sobre estas fechas.
function relojesDe(lead, params, ahora = new Date()) {
  const bloqueadoHasta = lead.disponibleDesde && lead.disponibleDesde > ahora
    ? lead.disponibleDesde
    : null;

  // El plazo de vida corre desde la primera llamada; si el lead se
  // reactivo, desde la reactivacion.
  const inicioPlazo = lead.reintentosDesde ?? lead.primeraLlamadaAt ?? null;
  const venceEl = inicioPlazo
    ? new Date(inicioPlazo.getTime() + params.horasParaTrash * 3600000)
    : null;

  return {
    // Hasta cuando no se puede repartir (el "candado" del protocolo).
    bloqueadoHasta,
    // Cierre de la ventana ideal de reparto.
    ventanaHasta: lead.disponibleHasta ?? null,
    ventanaVencida: !!lead.disponibleHasta && lead.disponibleHasta < ahora && !bloqueadoHasta,
    // Cuando el lead se descarta solo por agotar su plazo.
    venceEl,
    // Por que esta bloqueado, en los terminos del protocolo.
    motivoBloqueo: bloqueadoHasta ? lead.ultimoDesenlace : null,
  };
}

// Arma el bloque que la pantalla dibuja. `intentos` y `ultimaLlamada` los
// trae quien llama, que es el que ya tiene las llamadas a mano.
function describirLead(lead, { intentos = 0, ultimaLlamada = null }, params, ahora = new Date()) {
  return {
    semaforo: colorDe(lead, intentos),
    intentos,
    ultimaLlamada,
    asignadoAt: lead.asignadoAt ?? null,
    primeraLlamadaAt: lead.primeraLlamadaAt ?? null,
    fechaReagenda: lead.fechaReagenda ?? null,
    ...relojesDe(lead, params, ahora),
  };
}

// Atajo para listas: resuelve los parametros una vez y describe todos.
async function describirLeads(leads, tenantId, conteos = new Map()) {
  const params = await getParametros(tenantId);
  const ahora = new Date();
  return leads.map((lead) => {
    const info = conteos.get(lead.id) ?? { intentos: 0, ultimaLlamada: null };
    return describirLead(lead, info, params, ahora);
  });
}

module.exports = { SELECT_SEMAFORO, describirLead, describirLeads, colorDe, relojesDe };
