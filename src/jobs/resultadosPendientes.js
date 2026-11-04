// Cierra las llamadas que nadie alcanzó a tipificar.
//
// El protocolo depende de que la vendedora diga qué pasó: ella es la única
// que sabe si el cliente colgó o si el número está apagado, y Twilio reporta
// las dos como `busy`. Pero no se puede depender SOLO de eso: la pestaña se
// cierra, la computadora se apaga, el turno termina. Un lead que se queda
// esperando un resultado que nunca llega es un lead congelado -- sigue
// asignado a alguien que ya no va a trabajarlo y no vuelve a la cola.
//
// Esta es esa red. Pasados unos minutos desde que Twilio avisó que la
// llamada terminó sin que nadie contestara, y si nadie registró el
// resultado, se aplica el protocolo con lo que Twilio reportó. Queda
// marcado como automático: la bitácora distingue lo que decidió una persona
// de lo que decidió un reloj.
//
// Por qué esperar y no hacerlo al instante: el webhook llega cuando se
// cuelga, y la vendedora elige en el modal unos segundos después. Actuar de
// inmediato le quitaría el lead de las manos justo mientras lo está
// clasificando, que es el problema que este rediseño vino a resolver.
const prisma = require("./../lib/prisma");
const { getParametros } = require("../lib/parametros");
const { registrarResultadoLlamada } = require("../lib/cicloLead");
const { LEAD_STATUSES_ABIERTOS } = require("../lib/leadStatus");

const INTERVAL_MS = 5 * 60 * 1000;

// Cuánto se le da a la vendedora para tipificar antes de que entre la red.
// Generoso a propósito: el costo de esperar de más es que un lead tarde
// unos minutos en volver a la cola; el de quedarse corto es arrebatarle el
// lead a quien lo está clasificando.
const GRACIA_MS = 10 * 60 * 1000;

// Tope por corrida. Si el job estuvo caído un día, se pone al corriente por
// tandas en vez de disparar cientos de transiciones de golpe.
const MAX_POR_CORRIDA = 200;

// Lo que Twilio reporta -> el resultado del catálogo que le corresponde.
//
// Es la misma clasificación que hacía `clasificarDesenlace`, expresada ya
// en los términos del modal para que la red y la vendedora escriban el
// mismo valor en `substatus`. Un desenlace desconocido cae en "no contesta",
// que es el candado más corto: esperar de más castiga al lead por una falta
// de información que no es suya.
const POR_DESENLACE = {
  "no-answer": "NO_CONTESTA",
  busy: "RECHAZA_LLAMADA",
  failed: "FUERA_DE_SERVICIO",
  canceled: "FUERA_DE_SERVICIO",
};

async function cerrarPendientes() {
  const corte = new Date(Date.now() - GRACIA_MS);

  const pendientes = await prisma.llamada.findMany({
    where: {
      // Nadie la tipificó.
      resultado: null,
      // Twilio ya dijo cómo terminó, y terminó sin que contestaran. Las
      // `completed` no entran: ahí hubo conversación y el desenlace lo
      // decide quien habló, no un reloj.
      desenlace: { in: Object.keys(POR_DESENLACE) },
      contestada: false,
      fecha: { lt: corte },
      // El lead sigue abierto y sigue asignado: si ya volvió a la cola o
      // ya se cerró, no hay nada que hacer.
      lead: {
        status: { in: LEAD_STATUSES_ABIERTOS },
        vendedorId: { not: null },
      },
    },
    select: {
      id: true,
      leadId: true,
      tenantId: true,
      desenlace: true,
      vendedorId: true,
      vendedor: { select: { id: true, nombre: true } },
    },
    orderBy: { fecha: "asc" },
    take: MAX_POR_CORRIDA,
  });

  const resumen = new Map();
  // Los parámetros se consultan una vez por empresa, no una por llamada.
  const params = new Map();

  for (const intento of pendientes) {
    try {
      if (!params.has(intento.tenantId)) {
        params.set(intento.tenantId, await getParametros(intento.tenantId));
      }
      // La empresa apagó el reintento automático: entonces la devolución a
      // la cola la hace una persona, como antes.
      if (!params.get(intento.tenantId).reintentoAutomatico) continue;

      const resultado = POR_DESENLACE[intento.desenlace] ?? "NO_CONTESTA";

      const salida = await registrarResultadoLlamada({
        leadId: intento.leadId,
        tenantId: intento.tenantId,
        // El movimiento se atribuye a quien marcó -- es su intento -- pero
        // va marcado como automático, así que la bitácora no se lo apunta
        // como una decisión suya.
        usuario: intento.vendedor ?? { id: intento.vendedorId, nombre: null },
        resultado,
        nota: "Sin resultado registrado: tipificado con el desenlace de la llamada",
        automatico: true,
        // El token amarra la acción a ESTE intento: si el job corre dos
        // veces sobre la misma llamada (reinicio, solapamiento de ticks),
        // la segunda no vuelve a mover el lead.
        token: `llamada-sin-resultado:${intento.id}`,
      });

      if (salida?.error) continue;
      resumen.set(intento.tenantId, (resumen.get(intento.tenantId) ?? 0) + 1);
    } catch (err) {
      console.error("no se pudo tipificar la llamada pendiente", intento.id, err);
    }
  }

  return Array.from(resumen, ([tenantId, total]) => ({ tenantId, total }));
}

function startResultadosPendientesJob() {
  const tick = async () => {
    try {
      for (const { tenantId, total } of await cerrarPendientes()) {
        console.log(`resultados pendientes: ${total} llamadas tipificadas (tenant ${tenantId})`);
      }
    } catch (err) {
      console.error("falló el barrido de resultados pendientes", err);
    }
  };

  setInterval(tick, INTERVAL_MS);
  // Arranque diferido: al levantar el servidor hay cosas más urgentes que
  // hacer que barrer llamadas de hace diez minutos.
  setTimeout(tick, 90 * 1000);
}

module.exports = { startResultadosPendientesJob, cerrarPendientes, POR_DESENLACE, GRACIA_MS };
