// Historial de llamadas por lead (ver model Llamada en schema.prisma).
//
// Una llamada deja rastro en dos momentos que no comparten request:
//   1. se marca      -> webhook de TwiML, crea el intento con su callSid
//   2. se resuelve   -> la vendedora registra venta / reagenda / descarta
//
// Entre los dos puede llegar el aviso de Twilio diciendo si contestaron.
// Esta libreria junta las tres piezas en una sola fila para que el historial
// se lea como lo que fue: un intento, con su desenlace y su consecuencia.

const prisma = require("./prisma");

// Ventana para considerar que un resultado pertenece al intento que se
// acaba de marcar. El marcador y el formulario de resultado son dos
// requests sin nada que los ate, asi que se amarran por cercania: misma
// vendedora, mismo lead, intento aun sin resultado y reciente.
//
// Dos horas es holgado a proposito. Pasarse (atribuir el resultado a un
// intento viejo) solo mezcla dos filas del historial; quedarse corto crea
// intentos fantasma que inflan la cuenta de "veces que se le llamo", que es
// justo el numero que se quiere confiable.
const VENTANA_MS = 2 * 60 * 60 * 1000;

// Registra que se marco. Nunca lanza: un fallo aqui no puede impedir la
// llamada, que es lo que de verdad importa en ese momento.
async function registrarIntento({ leadId, vendedorId, tenantId, callSid, estadoAntes }) {
  try {
    if (!leadId || !vendedorId || !tenantId) return null;
    return await prisma.llamada.create({
      data: { leadId, vendedorId, tenantId, callSid: callSid || null, estadoAntes: estadoAntes || null },
    });
  } catch (err) {
    // P2002: el webhook de Twilio se reintenta; el intento ya estaba escrito.
    if (err?.code !== "P2002") console.error("registrarIntento falló", leadId, err);
    return null;
  }
}

// Completa el intento con lo que Twilio reporta al terminar el <Dial>.
async function registrarDesenlace({ callSid, desenlace, duracion }) {
  try {
    if (!callSid) return null;
    return await prisma.llamada.update({
      where: { callSid },
      data: {
        desenlace: desenlace || null,
        // "completed" es el unico desenlace en el que alguien descolgo.
        contestada: desenlace === "completed",
        duracion: Number.isFinite(duracion) && duracion > 0 ? duracion : undefined,
      },
    });
  } catch (err) {
    // P2025: no hay intento con ese callSid (se marco con la grabacion y el
    // historial apagados, o la fila se borro). No hay nada que completar.
    if (err?.code !== "P2025") console.error("registrarDesenlace falló", callSid, err);
    return null;
  }
}

// El intento abierto al que le corresponde un resultado, si lo hay.
async function intentoAbierto(leadId, vendedorId) {
  return prisma.llamada.findFirst({
    where: {
      leadId,
      vendedorId,
      resultado: null,
      fecha: { gte: new Date(Date.now() - VENTANA_MS) },
    },
    orderBy: { fecha: "desc" },
  });
}

// Cierra el intento con lo que paso despues de colgar. Si no hay intento
// abierto crea la fila: la vendedora pudo haber llamado por fuera del
// marcador, y ese resultado sigue siendo parte del historial del lead.
// `implicaContacto` dice si registrar este resultado prueba que hubo
// conversación. Vender o reagendar sí la prueban: nadie lo hace sin hablar.
// Devolver el lead a la cola NO: casi siempre es justo lo contrario, "le
// llamé y no contestó". Darlo por contestado arruinaría el único número que
// el historial existe para responder bien.
async function registrarResultado({
  leadId,
  vendedorId,
  tenantId,
  resultado,
  notas,
  ofertas,
  duracion,
  estadoAntes,
  estadoDespues,
  implicaContacto = true,
}) {
  try {
    if (!leadId || !vendedorId || !tenantId) return null;

    const datos = {
      resultado: resultado || null,
      notas: notas ?? undefined,
      ofertas: ofertas ?? undefined,
      estadoDespues: estadoDespues || null,
    };
    if (Number.isFinite(duracion) && duracion > 0) datos.duracion = duracion;

    const abierto = await intentoAbierto(leadId, vendedorId);
    if (abierto) {
      return await prisma.llamada.update({
        where: { id: abierto.id },
        data: {
          ...datos,
          // Lo que diga Twilio manda; el resultado solo puede confirmar el
          // contacto, nunca desmentirlo.
          contestada: abierto.contestada || (implicaContacto && Boolean(resultado)),
        },
      });
    }

    return await prisma.llamada.create({
      data: {
        leadId,
        vendedorId,
        tenantId,
        ...datos,
        ofertas: ofertas ?? [],
        estadoAntes: estadoAntes || null,
        contestada: implicaContacto && Boolean(resultado),
      },
    });
  } catch (err) {
    console.error("registrarResultado falló", leadId, err);
    return null;
  }
}

// El historial completo de un lead, mas el resumen que se lee de un vistazo.
async function historialDeLead(leadId, tenantId) {
  const llamadas = await prisma.llamada.findMany({
    where: { leadId, tenantId },
    orderBy: { fecha: "desc" },
    include: { vendedor: { select: { id: true, nombre: true } } },
  });

  // La grabación se trae aparte: pertenece a otra tabla y puede no existir
  // (grabación apagada, o llamada que nadie contestó).
  const conSid = llamadas.filter((l) => l.callSid).map((l) => l.callSid);
  const grabaciones = conSid.length
    ? await prisma.grabacionLlamada.findMany({
        where: { callSid: { in: conSid }, tenantId },
        select: { id: true, callSid: true, estado: true, duracion: true },
      })
    : [];
  const porSid = new Map(grabaciones.map((g) => [g.callSid, g]));

  return {
    resumen: {
      intentos: llamadas.length,
      contestadas: llamadas.filter((l) => l.contestada).length,
      ultimoIntento: llamadas[0]?.fecha ?? null,
      // Quién ha trabajado este lead, sin repetir.
      vendedoras: [
        ...new Map(llamadas.filter((l) => l.vendedor).map((l) => [l.vendedor.id, l.vendedor])).values(),
      ],
    },
    llamadas: llamadas.map((l) => {
      const g = l.callSid ? porSid.get(l.callSid) : null;
      return {
        id: l.id,
        fecha: l.fecha,
        vendedor: l.vendedor,
        duracion: l.duracion,
        contestada: l.contestada,
        desenlace: l.desenlace,
        resultado: l.resultado,
        notas: l.notas,
        ofertas: l.ofertas,
        estadoAntes: l.estadoAntes,
        estadoDespues: l.estadoDespues,
        grabacionId: g && g.estado === "COMPLETADA" ? g.id : null,
      };
    }),
  };
}

module.exports = {
  registrarIntento,
  registrarDesenlace,
  registrarResultado,
  historialDeLead,
};
