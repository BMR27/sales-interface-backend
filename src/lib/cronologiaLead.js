// Todo lo que le ha pasado a un lead, en una sola linea de tiempo.
//
// La informacion ya existia, pero repartida en tres sitios que nadie podia
// cruzar a mano: las llamadas en `Llamada`, los movimientos en el kardex
// (`AuditLog`) y las fechas sueltas del propio lead (cuando se asigno,
// cuando lo devolvieron, cuando se descarto). Para reconstruir la historia
// de un lead -- lo que hace falta cuando el proveedor reclama un descarte o
// una vendedora dice que si llamo -- habia que mirar en los tres.
//
// Aqui se juntan y se ordenan. Cada evento lleva su hora exacta, quien lo
// hizo y que cambio, porque en una operacion donde cada lead cuesta dinero
// "se descarto" no es una respuesta: la respuesta es "a las 11:42, tras 3
// intentos, por numero inexistente, y lo marco Elizabeth".
const prisma = require("./prisma");
const { motivoLabel } = require("./motivosDescarte");
const { DESENLACES } = require("./protocoloLeads");

// Como se lee cada desenlace de Twilio en la linea de tiempo.
const TEXTO_DESENLACE = {
  completed: "Contestó",
  "no-answer": "No contestó",
  busy: "Comunicando o rechazó",
  failed: "Fuera de servicio",
  canceled: "Cancelada antes de conectar",
};

function duracionLegible(segundos) {
  if (!segundos) return null;
  if (segundos < 60) return `${segundos}s`;
  const min = Math.floor(segundos / 60);
  const seg = segundos % 60;
  return seg ? `${min}m ${seg}s` : `${min}m`;
}

// Movimientos del kardex que cuentan la historia del lead. El resto
// (lecturas, cambios de direccion) solo haria ruido.
const ACCIONES_RELEVANTES = /lead|venta|asign|descart|reactiv|supervis|devol|reagend/i;

async function cronologiaDeLead(leadId, tenantId) {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, tenantId },
    include: {
      vendedor: { select: { id: true, nombre: true } },
      descartadoPor: { select: { nombre: true } },
      reagendaVendedorSugerido: { select: { nombre: true } },
      venta: { select: { monto: true, fecha: true, folio: true } },
    },
  });
  if (!lead) return null;

  const [llamadas, movimientos] = await Promise.all([
    prisma.llamada.findMany({
      where: { leadId, tenantId },
      orderBy: { fecha: "asc" },
      include: { vendedor: { select: { id: true, nombre: true } } },
    }),
    prisma.auditLog.findMany({
      where: { tenantId, entidad: "Lead", entidadId: String(leadId) },
      orderBy: { createdAt: "asc" },
      select: {
        createdAt: true, accion: true, descripcion: true,
        userNombre: true, userRol: true, origen: true,
      },
    }),
  ]);

  const eventos = [];

  eventos.push({
    tipo: "creado",
    en: lead.createdAt,
    titulo: "Lead recibido",
    detalle: lead.source === "EXTERNAL_API" ? "Entró por la API del proveedor" : "Alta manual",
    autor: null,
  });

  if (lead.asignadoAt) {
    eventos.push({
      tipo: "asignado",
      en: lead.asignadoAt,
      titulo: lead.vendedor ? `Asignado a ${lead.vendedor.nombre}` : "Asignado",
      detalle: lead.asignadoPorCoordinador ? "Reparto de la coordinadora" : "Reparto automático",
      autor: null,
    });
  }

  llamadas.forEach((ll, i) => {
    const partes = [];
    if (ll.desenlace) partes.push(TEXTO_DESENLACE[ll.desenlace] ?? ll.desenlace);
    const dur = duracionLegible(ll.duracion);
    if (dur) partes.push(`duró ${dur}`);
    if (ll.estadoAntes && ll.estadoDespues && ll.estadoAntes !== ll.estadoDespues) {
      partes.push(`${ll.estadoAntes} → ${ll.estadoDespues}`);
    }
    if (ll.resultado) partes.push(ll.resultado);

    eventos.push({
      tipo: ll.contestada ? "llamada_contestada" : "llamada_sin_respuesta",
      en: ll.fecha,
      titulo: `Intento ${i + 1}${ll.contestada ? " — contestó" : ""}`,
      detalle: partes.join(" · ") || "Sin datos del desenlace",
      autor: ll.vendedor?.nombre ?? null,
      nota: ll.notas ?? null,
    });
  });

  if (lead.devueltoAt) {
    eventos.push({
      tipo: "devuelto",
      en: lead.devueltoAt,
      titulo: "Volvió a la cola",
      detalle: lead.devueltoMotivo ?? "Sin motivo registrado",
      autor: lead.devueltoPorNombre ?? null,
    });
  }

  if (lead.supervisionPedidaAt) {
    eventos.push({
      tipo: "supervision",
      en: lead.supervisionPedidaAt,
      titulo: "Pasó a supervisión",
      detalle: lead.supervisionNota ?? "El cliente pidió algo que la vendedora no podía resolver",
      autor: null,
    });
  }

  if (lead.fechaReagenda) {
    eventos.push({
      tipo: "reagenda",
      // La reagenda se muestra en su hora pactada, no en la de captura:
      // es un evento futuro y ahi es donde importa verlo.
      en: lead.fechaReagenda,
      titulo: "Re-llamada pactada",
      detalle: lead.reagendaVendedorSugerido
        ? `Prioridad para ${lead.reagendaVendedorSugerido.nombre}, que atendió la llamada`
        : "El cliente pidió que le llamaran a esta hora",
      autor: null,
      futuro: lead.fechaReagenda > new Date(),
    });
  }

  if (lead.disponibleDesde && lead.disponibleDesde > new Date()) {
    const d = DESENLACES[lead.ultimoDesenlace];
    eventos.push({
      tipo: "bloqueo",
      en: lead.disponibleDesde,
      titulo: "Se libera para repartir",
      detalle: d
        ? `Bloqueado por el protocolo: ${d.clave.toLowerCase().replace(/_/g, " ")}`
        : "Bloqueado por el protocolo de reintento",
      autor: null,
      futuro: true,
    });
  }

  if (lead.descartadoAt) {
    eventos.push({
      tipo: "descartado",
      en: lead.descartadoAt,
      titulo: `Descartado — ${motivoLabel(lead.motivoDescarte)}`,
      detalle: lead.motivoDescarteNota ?? "Sin nota",
      // Sin autor cuando lo descartó el protocolo: atribuírselo a una
      // persona sería culparla de una regla que no decidió.
      autor: lead.descartadoPor?.nombre ?? "Protocolo automático",
    });
  }

  if (lead.venta) {
    eventos.push({
      tipo: "venta",
      en: lead.venta.fecha,
      titulo: `Venta cerrada — $${Math.round(lead.venta.monto).toLocaleString("es-MX")}`,
      detalle: lead.venta.folio ? `Folio ${lead.venta.folio}` : "Sin folio",
      autor: lead.vendedor?.nombre ?? null,
    });
  }

  // El kardex aporta lo que nadie mas registra: reasignaciones entre
  // vendedoras, reactivaciones, ediciones. Se filtra lo que no cuenta
  // historia para que la linea no se vuelva ilegible.
  for (const m of movimientos) {
    if (!ACCIONES_RELEVANTES.test(m.accion) && !ACCIONES_RELEVANTES.test(m.descripcion)) continue;
    eventos.push({
      tipo: "movimiento",
      en: m.createdAt,
      titulo: m.descripcion,
      detalle: m.origen === "api_externa" ? "Desde la API" : null,
      autor: m.userNombre ?? null,
      rol: m.userRol ?? null,
    });
  }

  eventos.sort((a, b) => new Date(a.en) - new Date(b.en));

  return {
    leadId: lead.id,
    folioPS: lead.folioPS,
    nombre: lead.nombre,
    status: lead.status,
    eventos,
    resumen: {
      intentos: llamadas.length,
      contestadas: llamadas.filter((l) => l.contestada).length,
      primeraLlamadaAt: lead.primeraLlamadaAt,
      ultimaLlamadaAt: llamadas.length ? llamadas[llamadas.length - 1].fecha : null,
      asignadoAt: lead.asignadoAt,
      vendedoraActual: lead.vendedor?.nombre ?? null,
      // Cuanto tiempo real lleva vivo este lead, que es lo que dice si el
      // seguimiento fue rapido o se dejo enfriar.
      horasDesdeLaPrimeraLlamada: lead.primeraLlamadaAt
        ? Math.round(((Date.now() - lead.primeraLlamadaAt.getTime()) / 3600000) * 10) / 10
        : null,
    },
  };
}

module.exports = { cronologiaDeLead };
