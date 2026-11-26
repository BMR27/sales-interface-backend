// Ventas concretadas con el pago en camino (ficha OXXO o CLABE SPEI).
//
// El cliente eligió OXXO o SPEI en el link: tiene su ficha o su CLABE pero
// el dinero llega después (horas, o hasta 3 días con OXXO). La vendedora ya
// no tiene que esperar para cerrar: la venta se cierra con su folio y queda
// marcada `pagoPendiente`, con o sin cobertura.
//
//   mientras no paga   la venta existe pero NO sale a FullVector: mandar el
//                      paquete sin cobrar sería regalarlo si nunca paga
//   paga               pasa a `prepagada` y se manda a FullVector con $0
//                      por cobrar al entregar (o al expediente de prepago
//                      si no hay cobertura)
//   vence sin pago     la venta se cancela sola, el inventario vuelve, se
//                      recalcula la comisión y se avisa
//
// Las dos señales llegan por el webhook de Stripe (ver
// src/lib/linksPago.js). Por si alguna se pierde, revisarPagosPendientes
// le pregunta a Stripe cada hora por las fichas que ya debieron resolverse.
const prisma = require("./prisma");
const { crearAviso } = require("./avisos");
const { emitir } = require("./eventos");

const METODOS = { oxxo: "OXXO", customer_balance: "SPEI" };

// El link vivo con ficha generada de un lead, o null.
async function linkConFicha(leadId) {
  return prisma.linkPago.findFirst({
    where: { leadId, estado: "PENDIENTE_PAGO" },
    orderBy: { createdAt: "desc" },
  });
}

// Lo que se escribe en la venta al crearla con la ficha pendiente.
function datosDePagoPendiente(link) {
  return {
    pagoPendiente: true,
    pagoPendienteMetodo: link.metodo || null,
    // SPEI no vence del lado de Stripe: la CLABE sirve hasta que llegue.
    pagoPendienteHasta: link.metodo === "oxxo" ? link.expiraAt : null,
  };
}

// El pago llegó: la venta deja de estar pendiente y sale a FullVector.
async function confirmarPagoDeVenta(leadId) {
  const venta = await prisma.venta.findUnique({ where: { leadId } });
  if (!venta?.pagoPendiente) return;
  const pagado = await prisma.linkPago.findFirst({
    where: { leadId, estado: "PAGADO" },
    orderBy: { pagadoAt: "desc" },
  });
  if (!pagado) return;

  const { count } = await prisma.venta.updateMany({
    where: { id: venta.id, pagoPendiente: true },
    data: {
      pagoPendiente: false,
      prepagada: true,
      pagoProveedor: "Stripe",
      pagoReferencia: pagado.stripePaymentIntentId || pagado.stripeSessionId,
      pagadoAt: pagado.pagadoAt || new Date(),
    },
  });
  if (count === 0) return;

  // Ahora sí: sale con $0 por cobrar (orderValue de una venta prepagada).
  const { syncVentaToFullVector } = require("./fullvector");
  await syncVentaToFullVector(venta.id).catch((err) => {
    console.error("no se pudo mandar a fullvector la venta pagada", venta.id, err);
  });
  emitir(venta.tenantId, "venta.cerrada", { leadId, pagada: true });
}

// La ficha venció (o el pago falló): la venta se cancela.
async function cancelarVentaPorPagoVencido(leadId) {
  const venta = await prisma.venta.findUnique({
    where: { leadId },
    include: { lead: { select: { nombre: true } } },
  });
  if (!venta?.pagoPendiente || venta.cancelada) return;

  const metodo = METODOS[venta.pagoPendienteMetodo] || "el pago";
  const motivo = venta.pagoPendienteMetodo === "oxxo"
    ? "La ficha OXXO venció sin pago"
    : `No llegó ${metodo === "SPEI" ? "la transferencia SPEI" : "el pago"}`;

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.venta.updateMany({
      where: { id: venta.id, pagoPendiente: true, cancelada: false },
      data: { pagoPendiente: false, cancelada: true, canceladaAt: new Date(), canceladaMotivo: motivo },
    });
    if (count === 0) return;

    // El inventario que salió con la venta vuelve: el paquete nunca se
    // mandó. Se registra como entrada para que el kardex cuadre.
    const salidas = await tx.movimientoInventario.findMany({ where: { ventaId: venta.id, tipo: "SALIDA" } });
    for (const s of salidas) {
      const producto = await tx.producto.update({
        where: { id: s.productoId },
        data: { stock: { increment: Math.abs(s.cantidad) } },
      });
      await tx.movimientoInventario.create({
        data: {
          productoId: s.productoId,
          tipo: "ENTRADA",
          cantidad: Math.abs(s.cantidad),
          stockResultante: producto.stock,
          motivo: `Cancelación venta #${venta.folio || venta.id}: ${motivo.toLowerCase()}`,
          tenantId: venta.tenantId,
          ventaId: venta.id,
        },
      });
    }
  });

  const { recalcularQuincena } = require("./comisiones");
  await recalcularQuincena(venta.tenantId, venta.vendedorId, venta.fecha).catch(() => {});

  const admins = await prisma.user.findMany({
    where: { tenantId: venta.tenantId, rol: { in: ["ADMIN", "ADMIN_OPERATIVO", "COORDINADOR"] }, activo: true },
    select: { id: true },
  });
  for (const userId of new Set([venta.vendedorId, ...admins.map((a) => a.id)])) {
    crearAviso({
      userId,
      tenantId: venta.tenantId,
      tipo: "venta.pago_vencido",
      categoria: "ALERTA",
      titulo: "Venta cancelada: no se pagó",
      mensaje: `${motivo}: la venta ${venta.folio || `#${venta.id}`} de ${venta.lead?.nombre || "el cliente"} se canceló y el inventario regresó.`,
      enlace: "/admin/ventas",
    });
  }
  emitir(venta.tenantId, "venta.cancelada", { leadId });
}

// Red de seguridad por si un webhook se pierde: las ventas cuya ficha ya
// debió resolverse se le preguntan directo a Stripe.
async function revisarPagosPendientes() {
  const { getStripe, isEnabled, procesarEventoStripe } = require("./linksPago");
  if (!isEnabled()) return;
  const vencidas = await prisma.venta.findMany({
    where: { pagoPendiente: true, pagoPendienteHasta: { lt: new Date() } },
    select: { leadId: true },
    take: 50,
  });
  for (const v of vencidas) {
    try {
      const link = await linkConFicha(v.leadId);
      if (!link) continue;
      const session = await getStripe().checkout.sessions.retrieve(link.stripeSessionId);
      // Se reusa el mismo camino que el webhook para no tener dos formas
      // de resolver lo mismo.
      if (session.payment_status === "paid") {
        await procesarEventoStripe({ type: "checkout.session.async_payment_succeeded", data: { object: session } });
      } else {
        const pi = session.payment_intent
          ? await getStripe().paymentIntents.retrieve(session.payment_intent)
          : null;
        if (!pi || ["canceled", "requires_payment_method"].includes(pi.status)) {
          await procesarEventoStripe({ type: "checkout.session.async_payment_failed", data: { object: session } });
        }
      }
    } catch (err) {
      console.error("no se pudo revisar el pago pendiente del lead", v.leadId, err.message);
    }
  }
}

function startRevisarPagosPendientesJob() {
  setTimeout(() => {
    revisarPagosPendientes();
    setInterval(revisarPagosPendientes, 60 * 60 * 1000);
  }, 90 * 1000);
}

module.exports = {
  METODOS,
  linkConFicha,
  datosDePagoPendiente,
  confirmarPagoDeVenta,
  cancelarVentaPorPagoVencido,
  revisarPagosPendientes,
  startRevisarPagosPendientesJob,
};
