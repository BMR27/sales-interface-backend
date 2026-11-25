// Cobro con Stripe por link: tarjeta, OXXO y SPEI.
//
// La vendedora ve el aviso de FC FV a media llamada, pulsa "Enviar link de
// pago" y el cliente paga desde su celular mientras siguen hablando. Todo
// cae en una sola cuenta de Stripe, la de STRIPE_SECRET_KEY.
//
// Se usa una Checkout Session por envío y no un Payment Link de Stripe: el
// Payment Link es reutilizable y de precio fijo, y aquí cada link lleva el
// monto exacto de ese carrito y el lead amarrado en la metadata. Así el
// webhook sabe a quién corresponde cada pago sin adivinar.
//
// OXXO y SPEI no se pagan en el momento: el cliente termina el checkout con
// una ficha o una CLABE y el dinero cae después. Por eso un link pasa por
// ENVIADO -> PENDIENTE_PAGO -> PAGADO, y sólo PAGADO libera el envío.
const Stripe = require("stripe");
const prisma = require("./prisma");
const { sendSms, isEnabled: smsEnabled } = require("./twilioSms");
const { normalizePhoneNumber } = require("./twilioVoice");
const { emitir } = require("./eventos");
const { crearAviso } = require("./avisos");

// Lo que tiene el cliente para abrir el checkout. Una ficha OXXO generada
// dentro de ese plazo sigue valiendo los días de OXXO_DIAS.
const MINUTOS_VIGENCIA = 60;
const OXXO_DIAS = 3;
// Stripe no cobra menos de $10 MXN.
const MONTO_MINIMO = 10;

const METODOS = { card: "tarjeta", oxxo: "OXXO", customer_balance: "SPEI" };

let cliente = null;
function getStripe() {
  if (!cliente) cliente = new Stripe(process.env.STRIPE_SECRET_KEY);
  return cliente;
}

function isEnabled() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

// Los métodos que se ofrecen son los que la cuenta tiene activos: si el
// checkout pide uno que no está habilitado en el dashboard (OXXO o
// transferencias), Stripe rechaza el link completo y la vendedora se queda
// sin poder cobrar ni con tarjeta. Se consulta a la cuenta y se guarda un
// rato, así que habilitar un método en Stripe basta para que aparezca.
const CAPACIDADES = { oxxo: "oxxo_payments", customer_balance: "bank_transfer_payments" };
const VIGENCIA_CAPACIDADES_MS = 10 * 60 * 1000;
let capacidades = null;

async function metodosActivos() {
  if (!capacidades || Date.now() - capacidades.en > VIGENCIA_CAPACIDADES_MS) {
    try {
      const cuenta = await getStripe().accounts.retrieve();
      capacidades = { en: Date.now(), valores: cuenta.capabilities || {} };
    } catch (err) {
      // Sin respuesta de la cuenta se cobra sólo con tarjeta, que siempre
      // está: mejor un link con menos opciones que ningún link.
      console.error("no se pudieron leer las capacidades de la cuenta de stripe", err.message);
      return ["card"];
    }
  }
  return ["card", ...Object.keys(CAPACIDADES).filter((m) => capacidades.valores[CAPACIDADES[m]] === "active")];
}

function serializarLink(l) {
  return {
    id: l.id,
    estado: l.estado,
    metodo: l.metodo,
    metodoLabel: l.metodo ? METODOS[l.metodo] || l.metodo : null,
    monto: l.monto,
    url: l.url,
    enviadoA: l.enviadoA,
    smsEnviado: Boolean(l.smsSid),
    smsError: l.smsError,
    enviadoPor: l.enviadoPorNombre,
    expiraAt: l.expiraAt,
    pagadoAt: l.pagadoAt,
    creadoAt: l.createdAt,
  };
}

// El método se sabe hasta que el cliente elige en el checkout. Nunca lanza:
// sin él el pago se registra igual, sólo sin la etiqueta.
async function metodoDelPago(paymentIntentId) {
  if (!paymentIntentId) return null;
  try {
    const pi = await getStripe().paymentIntents.retrieve(paymentIntentId, { expand: ["payment_method"] });
    return pi.payment_method?.type || null;
  } catch (err) {
    console.error("no se pudo leer el metodo del pago de stripe", paymentIntentId, err.message);
    return null;
  }
}

// Crea el checkout, guarda el link y lo manda por SMS. Si el SMS falla el
// link se guarda igual y se devuelve con `smsError`: la vendedora todavía
// puede dictarlo o copiarlo, y el cliente sigue en la línea.
async function crearYEnviarLink({ lead, monto, user }) {
  const stripe = getStripe();

  // Un link nuevo reemplaza a los que el cliente no ha abierto: así no
  // quedan dos checkouts vivos con los que pudiera pagar dos veces.
  const abiertos = await prisma.linkPago.findMany({ where: { leadId: lead.id, estado: "ENVIADO" } });
  for (const l of abiertos) {
    await stripe.checkout.sessions.expire(l.stripeSessionId).catch(() => {});
    await prisma.linkPago.update({ where: { id: l.id }, data: { estado: "VENCIDO" } });
  }

  // SPEI necesita un Customer (Stripe le asigna su propia CLABE). Se
  // reutiliza el del lead para que un segundo link no le dé otra CLABE.
  const previo = await prisma.linkPago.findFirst({
    where: { leadId: lead.id, stripeCustomerId: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  const customerId =
    previo?.stripeCustomerId ||
    (
      await stripe.customers.create({
        name: `${lead.nombre} ${lead.apellido || ""}`.trim(),
        phone: normalizePhoneNumber(lead.telefono),
        metadata: { leadId: String(lead.id), tenantId: String(lead.tenantId), folio: lead.folioPS || "" },
      })
    ).id;

  const metodos = await metodosActivos();
  const metadata = { leadId: String(lead.id), tenantId: String(lead.tenantId), folio: lead.folioPS || "" };
  const expiraAt = new Date(Date.now() + MINUTOS_VIGENCIA * 60 * 1000);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    locale: "es-419",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "mxn",
          unit_amount: Math.round(monto * 100),
          product_data: { name: lead.cantidad > 1 ? `${lead.producto} (x${lead.cantidad})` : lead.producto },
        },
      },
    ],
    payment_method_types: metodos,
    payment_method_options: {
      ...(metodos.includes("oxxo") ? { oxxo: { expires_after_days: OXXO_DIAS } } : {}),
      ...(metodos.includes("customer_balance")
        ? { customer_balance: { funding_type: "bank_transfer", bank_transfer: { type: "mx_bank_transfer" } } }
        : {}),
    },
    payment_intent_data: { description: `Pedido ${lead.folioPS || lead.id}`, metadata },
    metadata,
    expires_at: Math.floor(expiraAt.getTime() / 1000),
    success_url: `${process.env.FRONTEND_URL}/pago-recibido`,
  });

  let link = await prisma.linkPago.create({
    data: {
      leadId: lead.id,
      tenantId: lead.tenantId,
      stripeSessionId: session.id,
      stripeCustomerId: customerId,
      url: session.url,
      monto,
      enviadoA: lead.telefono,
      enviadoPorId: user.id,
      enviadoPorNombre: user.nombre || user.email || null,
      expiraAt,
    },
  });

  const opciones = metodos.map((m) => ({ card: "con tarjeta", oxxo: "en OXXO", customer_balance: "por transferencia SPEI" })[m]);
  const mensaje =
    `Hola ${lead.nombre}, este es tu link para pagar tu ${lead.producto} por ` +
    `$${monto.toLocaleString("es-MX")}: ${session.url} ` +
    `Puedes pagar ${opciones.length > 1 ? `${opciones.slice(0, -1).join(", ")} o ${opciones.at(-1)}` : opciones[0]}.`;
  try {
    if (!smsEnabled()) throw new Error("SMS no configurado");
    const sms = await sendSms(lead.telefono, mensaje);
    link = await prisma.linkPago.update({ where: { id: link.id }, data: { smsSid: sms.sid } });
  } catch (err) {
    console.error("no se pudo mandar el link de pago por sms", link.id, err.message);
    link = await prisma.linkPago.update({
      where: { id: link.id },
      data: { smsError: String(err.message || err).slice(0, 300) },
    });
  }

  emitir(lead.tenantId, "pago.actualizado", { leadId: lead.id });
  return link;
}

// Cruza los cobros del lead con su venta. El pago y la venta llegan en
// cualquier orden -- el cliente puede pagar antes de que la vendedora
// confirme el carrito, o la ficha OXXO caer días después -- así que esto
// se llama desde los dos lados: cuando Stripe confirma un pago y cuando se
// registra la venta o se abre su expediente de prepago.
//
// Idempotente: un pago que ya se aplicó (misma referencia) no se vuelve a
// apuntar.
async function aplicarCobroALaVenta(leadId) {
  try {
    const venta = await prisma.venta.findUnique({ where: { leadId } });
    if (!venta) return;

    const pagado = await prisma.linkPago.findFirst({
      where: { leadId, estado: "PAGADO" },
      orderBy: { pagadoAt: "desc" },
    });
    if (!pagado) return;

    const referencia = pagado.stripePaymentIntentId || pagado.stripeSessionId;
    const metodo = pagado.metodo ? METODOS[pagado.metodo] || pagado.metodo : null;

    // Una venta pagada por link necesita expediente aunque FullVector no la
    // haya marcado sin cobertura: es donde se ve que ya se cobró y donde se
    // registra el envío.
    // upsert y no find+create: la sincronización con FullVector puede estar
    // abriendo el mismo expediente en este instante.
    const gestion = await prisma.prepagoGestion.upsert({
      where: { ventaId: venta.id },
      create: { ventaId: venta.id, tenantId: venta.tenantId },
      update: {},
    });
    if (gestion.pagoReferencia === referencia) return;

    const pendiente = ["PENDIENTE_CONTACTO", "TRANSFERENCIA_OFRECIDA"].includes(gestion.estado);
    await prisma.$transaction([
      prisma.prepagoGestion.update({
        where: { id: gestion.id },
        data: {
          pagoReferencia: referencia,
          pagoMonto: pagado.monto,
          ...(pendiente
            ? { estado: "PAGO_CONFIRMADO", pagoConfirmadoAt: pagado.pagadoAt || new Date(), pagoConfirmadoPor: metodo ? `Stripe (${metodo})` : "Stripe" }
            : {}),
        },
      }),
      prisma.prepagoNota.create({
        data: {
          gestionId: gestion.id,
          nota: `Pago recibido por Stripe${metodo ? ` con ${metodo}` : ""}: $${pagado.monto.toLocaleString("es-MX")}. Referencia ${referencia}.`,
          autorNombre: "Stripe",
          tenantId: venta.tenantId,
        },
      }),
    ]);
  } catch (err) {
    console.error("no se pudo aplicar el cobro de stripe a la venta del lead", leadId, err);
  }
}

// --- Webhook -------------------------------------------------------------
//
// Cada transición se hace con updateMany y el estado de origen en el where:
// si Stripe reintenta un evento, o llegan dos a la vez, sólo uno cambia la
// fila y sólo ése dispara los avisos.

async function marcarPagado(session) {
  const link = await prisma.linkPago.findUnique({ where: { stripeSessionId: session.id } });
  if (!link) return;
  const paymentIntentId = session.payment_intent || null;
  const { count } = await prisma.linkPago.updateMany({
    where: { id: link.id, estado: { not: "PAGADO" } },
    data: {
      estado: "PAGADO",
      pagadoAt: new Date(),
      stripePaymentIntentId: paymentIntentId,
      metodo: (await metodoDelPago(paymentIntentId)) || link.metodo,
      ...(session.amount_total ? { monto: session.amount_total / 100 } : {}),
    },
  });
  if (count === 0) return;

  await aplicarCobroALaVenta(link.leadId);

  const lead = await prisma.lead.findUnique({ where: { id: link.leadId }, select: { nombre: true, vendedorId: true } });
  const avisar = new Set([link.enviadoPorId, lead?.vendedorId].filter(Boolean));
  for (const userId of avisar) {
    crearAviso({
      userId,
      tenantId: link.tenantId,
      tipo: "pago.recibido",
      categoria: "EXITO",
      titulo: "El cliente pagó",
      mensaje: `${lead?.nombre || "El cliente"} pagó $${Math.round(session.amount_total / 100 || link.monto).toLocaleString("es-MX")} con el link de pago.`,
    });
  }
  emitir(link.tenantId, "pago.actualizado", { leadId: link.leadId });
}

async function marcarPendiente(session) {
  const link = await prisma.linkPago.findUnique({ where: { stripeSessionId: session.id } });
  if (!link) return;
  const { count } = await prisma.linkPago.updateMany({
    where: { id: link.id, estado: "ENVIADO" },
    data: {
      estado: "PENDIENTE_PAGO",
      stripePaymentIntentId: session.payment_intent || null,
      metodo: await metodoDelPago(session.payment_intent),
    },
  });
  if (count > 0) emitir(link.tenantId, "pago.actualizado", { leadId: link.leadId });
}

async function marcarCerrado(session, estado, desde) {
  const link = await prisma.linkPago.findUnique({ where: { stripeSessionId: session.id } });
  if (!link) return;
  const { count } = await prisma.linkPago.updateMany({
    where: { id: link.id, estado: { in: desde } },
    data: { estado },
  });
  if (count > 0) emitir(link.tenantId, "pago.actualizado", { leadId: link.leadId });
}

async function procesarEventoStripe(event) {
  const session = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
      // Con tarjeta el checkout termina pagado. Con OXXO o SPEI termina con
      // la ficha o la CLABE en la mano y `payment_status` en unpaid.
      if (session.payment_status === "paid") return marcarPagado(session);
      return marcarPendiente(session);
    case "checkout.session.async_payment_succeeded":
      return marcarPagado(session);
    case "checkout.session.async_payment_failed":
      return marcarCerrado(session, "FALLIDO", ["ENVIADO", "PENDIENTE_PAGO"]);
    case "checkout.session.expired":
      return marcarCerrado(session, "VENCIDO", ["ENVIADO"]);
    default:
      return undefined;
  }
}

module.exports = {
  isEnabled,
  getStripe,
  MONTO_MINIMO,
  serializarLink,
  crearYEnviarLink,
  aplicarCobroALaVenta,
  procesarEventoStripe,
};
