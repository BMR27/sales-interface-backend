// Tickets diarios de comisión: cómo se generan, se aprueban y se firman.
//
// La comisión vive por QUINCENA y se paga por bloques de piezas (ver
// src/lib/comisiones.js). Eso no se toca: el ticket diario no es otra
// forma de calcular, es una FOTO de lo que esa jornada aportó al
// acumulado de la quincena.
//
// Por qué una foto y no una consulta en vivo: la comisión de la quincena
// se recalcula entera cada vez que se confirma una entrega o se cancela
// una venta. Un número que cambia solo sirve para ver cómo va la
// quincena, no para cobrar: nadie firma un recibo cuyo importe puede ser
// otro mañana. Al cerrar la jornada el importe se congela y lo único que
// cambia después es el estatus.
//
// El recorrido es siempre el mismo y no se salta pasos:
//
//   EN_APROBACION -> APROBADO   lo hace la coordinadora, y su firma queda
//   APROBADO      -> LIQUIDADO  lo hace la vendedora con su contraseña,
//                               como acuse de que recibió el pago
//
// Firmar NO mueve dinero: este sistema no paga. Deja constancia de quién
// revisó y quién recibió, que es lo que hoy se resuelve de palabra.
const bcrypt = require("bcryptjs");
const prisma = require("./prisma");
const { calcularQuincenaVendedora } = require("./comisiones");
const { inicioDeDia, finDeDia, diaLocal } = require("./fechasLocales");

const EN_APROBACION = "EN_APROBACION";
const APROBADO = "APROBADO";
const LIQUIDADO = "LIQUIDADO";

const ESTATUS = [EN_APROBACION, APROBADO, LIQUIDADO];

const ESTATUS_LABEL = {
  EN_APROBACION: "En aprobación",
  APROBADO: "Aprobado",
  LIQUIDADO: "Liquidado",
};

// Lo que esa jornada aportó al acumulado de su quincena.
//
// Se saca del detalle que ya calcula comisiones.js: ahí cada venta trae
// `comisionNueva`, que es justo lo que esa venta agregó al pasar por el
// corte de bloques. Sumar las del día es la comisión del día, y la suma
// de todos los días de la quincena da exactamente la comisión de la
// quincena -- que es la propiedad que hace que esto no invente dinero.
async function calcularDia(tenantId, vendedorId, fecha) {
  const quincena = await calcularQuincenaVendedora(tenantId, vendedorId, fecha);
  const dia = diaLocal(fecha);

  const delDia = quincena.ventas.filter((v) => diaLocal(v.fecha) === dia);

  return {
    piezas: delDia.filter((v) => v.cuenta).reduce((s, v) => s + v.piezas, 0),
    ventas: delDia.length,
    monto: delDia.reduce((s, v) => s + v.comisionNueva, 0),
    detalle: delDia.map((v) => ({
      ventaId: v.ventaId,
      folio: v.folio,
      fecha: v.fecha,
      piezas: v.piezas,
      cuenta: v.cuenta,
      motivoNoCuenta: v.motivoNoCuenta,
      comision: v.comisionNueva,
    })),
  };
}

// Cierra la jornada de una vendedora y deja el ticket listo para revisar.
//
// Idempotente por el índice único (tenant, vendedora, fecha): correrlo
// dos veces no genera dos tickets ni paga dos veces. Si el ticket ya
// existe y SIGUE en aprobación se actualiza -- una entrega confirmada
// tarde todavía puede entrar --; si ya lo aprobaron o lo firmaron no se
// toca, porque a partir de ahí es un documento, no un cálculo.
async function generarTicket(tenantId, vendedorId, fecha = new Date()) {
  const dia = inicioDeDia(diaLocal(fecha));
  const calculo = await calcularDia(tenantId, vendedorId, fecha);

  // Un día sin ventas no genera ticket: un recibo de cero pesos no es
  // información, es ruido que hay que aprobar.
  if (calculo.ventas === 0) return null;

  const existente = await prisma.ticketComision.findUnique({
    where: { tenantId_vendedorId_fecha: { tenantId, vendedorId, fecha: dia } },
  });

  if (existente && existente.estatus !== EN_APROBACION) return existente;

  if (existente) {
    return prisma.ticketComision.update({
      where: { id: existente.id },
      data: { piezas: calculo.piezas, ventas: calculo.ventas, monto: calculo.monto, detalle: calculo.detalle },
    });
  }

  return prisma.ticketComision.create({
    data: {
      tenantId,
      vendedorId,
      fecha: dia,
      piezas: calculo.piezas,
      ventas: calculo.ventas,
      monto: calculo.monto,
      detalle: calculo.detalle,
      estatus: EN_APROBACION,
    },
  });
}

// Cierra la jornada de TODAS las vendedoras que vendieron ese día.
//
// Se parte de las ventas y no de la lista de vendedoras: quien no vendió
// no necesita ticket, y recorrer a las 30 para descartar 25 es trabajo de
// más en un job que corre todos los días.
async function generarTicketsDelDia(tenantId, fecha = new Date()) {
  const inicio = inicioDeDia(diaLocal(fecha));
  const fin = finDeDia(diaLocal(fecha));

  const conVentas = await prisma.venta.groupBy({
    by: ["vendedorId"],
    where: { tenantId, fecha: { gte: inicio, lte: fin } },
  });

  const tickets = [];
  for (const { vendedorId } of conVentas) {
    try {
      const t = await generarTicket(tenantId, vendedorId, fecha);
      if (t) tickets.push(t);
    } catch (err) {
      // Un fallo en una vendedora no puede dejar sin ticket a las demás.
      console.error("no se pudo generar el ticket de comisión", vendedorId, err);
    }
  }
  return tickets;
}

// La coordinadora revisó que las órdenes y los importes estén bien.
async function aprobar(tenantId, ticketId, usuario) {
  const t = await prisma.ticketComision.findFirst({ where: { id: ticketId, tenantId } });
  if (!t) return { error: "No se encontró el ticket" };
  if (t.estatus === LIQUIDADO) return { error: "Ese ticket ya está liquidado" };
  if (t.estatus === APROBADO) return { error: "Ese ticket ya estaba aprobado" };

  const ticket = await prisma.ticketComision.update({
    where: { id: ticketId },
    data: { estatus: APROBADO, aprobadoPorId: usuario.id, aprobadoAt: new Date() },
  });
  return { ticket };
}

// La vendedora firma con su contraseña como acuse de que recibió el pago.
//
// Se pide la contraseña y no un botón a secas porque esto es una firma:
// lo que se está afirmando es "recibí este dinero". Un clic sin
// credencial no distingue a la persona de quien se quedó en su sesión.
async function firmar(tenantId, ticketId, usuario, password) {
  const t = await prisma.ticketComision.findFirst({ where: { id: ticketId, tenantId } });
  if (!t) return { error: "No se encontró el ticket" };
  // Cada quien firma lo suyo. No es paranoia: el acuse de pago de otra
  // persona no lo puede dar nadie más.
  if (t.vendedorId !== usuario.id) return { error: "Ese ticket no es tuyo" };
  if (t.estatus === EN_APROBACION) {
    return { error: "Tu coordinadora todavía no aprueba este ticket" };
  }
  if (t.estatus === LIQUIDADO) return { error: "Ese ticket ya está firmado" };

  if (!password) return { error: "Escribe tu contraseña para firmar" };
  const user = await prisma.user.findUnique({ where: { id: usuario.id }, select: { password: true } });
  const ok = user && (await bcrypt.compare(String(password), user.password));
  if (!ok) return { error: "La contraseña no es correcta" };

  const ticket = await prisma.ticketComision.update({
    where: { id: ticketId },
    data: { estatus: LIQUIDADO, firmadoAt: new Date() },
  });
  return { ticket };
}

module.exports = {
  EN_APROBACION, APROBADO, LIQUIDADO, ESTATUS, ESTATUS_LABEL,
  calcularDia, generarTicket, generarTicketsDelDia, aprobar, firmar,
};
