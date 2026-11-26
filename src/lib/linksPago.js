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
const crypto = require("crypto");
const Stripe = require("stripe");
const prisma = require("./prisma");
const { sendSms, isEnabled: smsEnabled } = require("./twilioSms");
const whatsapp = require("./twilioWhatsapp");
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

// --- Link corto ------------------------------------------------------------
//
// La URL del checkout de Stripe pasa de 400 caracteres: en un SMS es medio
// mensaje de basura y el cliente no sabe de quién es. El SMS lleva en su
// lugar perfectself.com.mx/pagar/<codigo>, que redirige al checkout.
//
// El código es el id del link en base 36 más una firma corta con
// JWT_SECRET. Sin la firma bastaría con cambiar el número para abrir el
// checkout de otro cliente; con ella no se puede adivinar. Así no hace falta
// guardar nada nuevo en la base.
function firma(id) {
  return crypto.createHmac("sha256", process.env.JWT_SECRET || "").update(`pago:${id}`).digest("base64url").slice(0, 8);
}

function codigoCorto(id) {
  return `${Number(id).toString(36)}-${firma(id)}`;
}

// El id del link si el código es auténtico; null si no.
function idDeCodigo(codigo) {
  const m = /^([0-9a-z]+)-([A-Za-z0-9_-]{8})$/.exec(String(codigo || ""));
  if (!m) return null;
  const id = parseInt(m[1], 36);
  if (!Number.isSafeInteger(id)) return null;
  const esperada = firma(id);
  return crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(m[2])) ? id : null;
}

function urlCorta(id) {
  return process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/pagar/${codigoCorto(id)}` : null;
}

function serializarLink(l) {
  return {
    id: l.id,
    estado: l.estado,
    metodo: l.metodo,
    metodoLabel: l.metodo ? METODOS[l.metodo] || l.metodo : null,
    monto: l.monto,
    url: l.url,
    urlCorta: urlCorta(l.id),
    enviadoA: l.enviadoA,
    canal: l.canal || "sms",
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

// Cómo se presenta el checkout: con la marca del espacio y no con la de la
// cuenta de Stripe. Todo cae en una sola cuenta (STRIPE_SECRET_KEY) cuyo
// nombre público es el de otro negocio, y el cliente de Perfect Self veía
// ese nombre arriba de la página de pago -- lo primero que lee antes de
// meter su tarjeta.
//
// `display_name` sólo cambia el encabezado del checkout: Stripe sigue
// usando el nombre de la cuenta en los términos y en los recibos. El estado
// de cuenta de la tarjeta lo decide el descriptor de la cuenta.
//
// Sin logo propio se usa el de la plataforma (el mismo que ve el frontend
// por defecto). Stripe descarga las imágenes por URL, así que sólo se
// mandan si son https: en local FRONTEND_URL es http y Stripe rechazaría
// el link completo.
const COLOR_MARCA = "#7e5a97";
async function brandingDelCheckout(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { nombreComercial: true, razonSocial: true, logoUrl: true, colorPrimario: true },
  });
  const base = process.env.FRONTEND_URL || "";
  const https = (u) => (u && /^https:\/\//.test(u) ? u : null);
  const logo = https(tenant?.logoUrl) || https(`${base}/brand/wordmark.png`);
  const icono = tenant?.logoUrl ? null : https(`${base}/brand/icon.png`);
  const color = /^#[0-9a-f]{6}$/i.test(tenant?.colorPrimario || "") ? tenant.colorPrimario : COLOR_MARCA;
  return {
    display_name: (tenant?.nombreComercial || tenant?.razonSocial || "").slice(0, 100) || undefined,
    button_color: color,
    ...(logo ? { logo: { type: "url", url: logo } } : {}),
    ...(icono ? { icon: { type: "url", url: icono } } : {}),
  };
}

// El texto del SMS. Va por renglones para que se lea de un vistazo en el
// celular: de quién es, qué paga, cuánto y dónde. Sin emojis a propósito:
// un solo emoji parte el SMS en más segmentos y en algunos teléfonos llega
// como un cuadro vacío.
const OPCIONES_PAGO = { card: "tarjeta", oxxo: "OXXO", customer_balance: "transferencia SPEI" };
function mensajeDelLink({ marca, nombre, producto, monto, url, metodos }) {
  const opciones = metodos.map((m) => OPCIONES_PAGO[m]).filter(Boolean);
  const lista = opciones.length > 1 ? `${opciones.slice(0, -1).join(", ")} y ${opciones.at(-1)}` : opciones[0];
  const primerNombre = String(nombre || "").trim().split(/\s+/)[0];
  return [
    ...(marca ? [marca, ""] : []),
    `Hola${primerNombre ? ` ${primerNombre}` : ""}, este es tu link para pagar tu pedido.`,
    "",
    producto,
    `Total: $${monto.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MXN`,
    "",
    "Paga aqui:",
    url,
    "",
    `Aceptamos ${lista}.`,
    `El link vence en ${MINUTOS_VIGENCIA} minutos.`,
  ].join("\n");
}

// Crea el checkout, guarda el link y lo manda por SMS. Si el SMS falla el
// link se guarda igual y se devuelve con `smsError`: la vendedora todavía
// puede dictarlo o copiarlo, y el cliente sigue en la línea.
async function crearYEnviarLink({ lead, monto, user, canal = "sms" }) {
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
  const branding = await brandingDelCheckout(lead.tenantId);
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
    // `allowed_` y no `payment_method_types`: la API de Stripe que trae el
    // SDK (2026-11-18) quitó el segundo, y con él todos los links fallaban.
    allowed_payment_method_types: metodos,
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
    branding_settings: branding,
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
      canal,
      enviadoPorId: user.id,
      enviadoPorNombre: user.nombre || user.email || null,
      expiraAt,
    },
  });

  const producto = lead.cantidad > 1 ? `${lead.producto} (x${lead.cantidad})` : lead.producto;
  try {
    let envio;
    if (canal === "whatsapp") {
      // Las variables de la plantilla, por posición (ver la plantilla en
      // Twilio Content): el botón "Pagar ahora" arma la URL con {{4}}.
      envio = await whatsapp.sendTemplate(lead.telefono, process.env.TWILIO_WHATSAPP_LINK_PAGO_SID, {
        1: String(lead.nombre || "").trim().split(/\s+/)[0] || "cliente",
        2: producto,
        3: `$${monto.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        4: codigoCorto(link.id),
      });
    } else {
      if (!smsEnabled()) throw new Error("SMS no configurado");
      envio = await sendSms(lead.telefono, mensajeDelLink({
        marca: branding.display_name,
        nombre: lead.nombre,
        producto,
        monto,
        url: urlCorta(link.id) || session.url,
        metodos,
      }));
    }
    link = await prisma.linkPago.update({ where: { id: link.id }, data: { smsSid: envio.sid } });
  } catch (err) {
    console.error(`no se pudo mandar el link de pago por ${canal}`, link.id, err.message);
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
    // El expediente de prepago es para lo que va por mensajería tradicional
    // (sin cobertura). Con cobertura el pago queda en la venta misma
    // (`prepagada`) y la orden sale a FullVector con $0 por cobrar.
    if (!venta.fullvectorSinCobertura) return;

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

// --- Cobro con cobertura --------------------------------------------------
//
// Con cobertura el cliente elige: paga ya con el link o paga en efectivo al
// recibir. Las dos cosas no pueden convivir en la misma venta, porque
// FullVector cobra lo que diga la orden: si el link se paga y la orden sale
// con el monto completo, el mensajero le cobra otra vez.
//
// La regla es simple y vive aquí para que la usen la llamada, el registro
// de la venta y el envío del link:
//
//   pagado      la venta nace prepagada: la orden sale con $0 por cobrar
//   pendiente   hay un link vivo sin pagar: no se cierra la venta hasta que
//               pague o hasta que se cancele el link y se pase a contra
//               entrega
//   ninguno     contra entrega, como siempre

// Lo que dice el cobro por link de un lead.
async function cobroDelLead(leadId) {
  const links = await prisma.linkPago.findMany({ where: { leadId }, orderBy: { createdAt: "desc" } });
  const pagado = links.find((l) => l.estado === "PAGADO") || null;
  const pendientes = links.filter((l) => l.estado === "ENVIADO" || l.estado === "PENDIENTE_PAGO");
  return { pagado, pendientes };
}

// El error que se le muestra a la vendedora si intenta cerrar con un link
// vivo. `null` si se puede cerrar. Sin cobertura (FC FV) no aplica: ahí no
// hay pago contra entrega, el link vivo es justo como se cobra.
//
// Una ficha OXXO o una CLABE ya generadas NO bloquean: la venta se cierra
// marcada con el pago pendiente y no sale a FullVector hasta que pague
// (ver src/lib/ventaPagoPendiente.js). Lo único que bloquea es un link que
// el cliente ni siquiera abrió: ahí todavía no se sabe si va a pagar en
// línea o al recibir.
async function bloqueoPorLinkPendiente(lead) {
  if (lead.coberturaFv === false) return null;
  const { pagado, pendientes } = await cobroDelLead(lead.id);
  if (pagado || pendientes.length === 0) return null;
  if (pendientes.some((l) => l.estado === "PENDIENTE_PAGO")) return null;
  return "El cliente tiene un link de pago que todavía no abre. Espera a que pague o genere su ficha, o cancela el link y pásalo a pago contra entrega.";
}

// Cancela los links vivos de un lead: el checkout que no se ha abierto se
// vence, y la ficha OXXO o la CLABE ya generadas se anulan cancelando su
// PaymentIntent. Si Stripe no deja cancelar uno (el pago ya se está
// procesando) se reporta y ese link se queda como está: el cliente pudo
// haber pagado y no hay que fingir lo contrario.
async function cancelarLinksVivos(leadId) {
  const stripe = getStripe();
  const { pendientes } = await cobroDelLead(leadId);
  const noCancelados = [];
  for (const l of pendientes) {
    try {
      if (l.estado === "ENVIADO") {
        await stripe.checkout.sessions.expire(l.stripeSessionId).catch((err) => {
          // Ya vencida del lado de Stripe: para nosotros es lo mismo.
          if (!/expired|not open|status of `expired`|complete/i.test(err.message || "")) throw err;
        });
      } else if (l.stripePaymentIntentId) {
        await stripe.paymentIntents.cancel(l.stripePaymentIntentId);
      }
      await prisma.linkPago.updateMany({
        where: { id: l.id, estado: { in: ["ENVIADO", "PENDIENTE_PAGO"] } },
        data: { estado: "VENCIDO" },
      });
    } catch (err) {
      console.error("no se pudo cancelar el link de pago", l.id, err.message);
      noCancelados.push(l.id);
    }
  }
  if (pendientes.length) emitir((await prisma.lead.findUnique({ where: { id: leadId }, select: { tenantId: true } })).tenantId, "pago.actualizado", { leadId });
  return { cancelados: pendientes.length - noCancelados.length, noCancelados };
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
  // Una venta cerrada con la ficha pendiente sale ahora a FullVector.
  await require("./ventaPagoPendiente").confirmarPagoDeVenta(link.leadId);
  await avisarSiHayCobroDoble(link, session);

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

// El pago llegó y la venta ya había salido a FullVector con cobro contra
// entrega. No debería pasar -- la venta no se cierra con un link vivo y no
// se manda link sobre una venta contra entrega -- pero un OXXO pagado en
// la ventana entre una cosa y otra lo dejaría pasar, y el costo es cobrarle
// dos veces al cliente. Se avisa a los administradores para que frenen el
// cobro en FullVector o reembolsen.
async function avisarSiHayCobroDoble(link, session) {
  try {
    const venta = await prisma.venta.findUnique({ where: { leadId: link.leadId } });
    if (!venta || venta.prepagada || venta.fullvectorSinCobertura) return;
    const admins = await prisma.user.findMany({
      where: { tenantId: link.tenantId, rol: { in: ["ADMIN", "ADMIN_OPERATIVO"] }, activo: true },
      select: { id: true },
    });
    const monto = Math.round(session.amount_total / 100 || link.monto).toLocaleString("es-MX");
    for (const a of new Set([...admins.map((x) => x.id), link.enviadoPorId].filter(Boolean))) {
      crearAviso({
        userId: a,
        tenantId: link.tenantId,
        tipo: "pago.cobro_doble",
        categoria: "ALERTA",
        titulo: "Posible cobro doble",
        mensaje: `La venta ${venta.folio || `#${venta.id}`} se pagó con link ($${monto}) pero salió a FullVector con cobro contra entrega. Pide que no se cobre al entregar o reembolsa el pago.`,
        enlace: "/admin/ventas",
      });
    }
  } catch (err) {
    console.error("no se pudo revisar el cobro doble", link.id, err);
  }
}

async function marcarPendiente(session) {
  const link = await prisma.linkPago.findUnique({ where: { stripeSessionId: session.id } });
  if (!link) return;
  const metodo = await metodoDelPago(session.payment_intent);
  const { count } = await prisma.linkPago.updateMany({
    where: { id: link.id, estado: "ENVIADO" },
    data: {
      estado: "PENDIENTE_PAGO",
      stripePaymentIntentId: session.payment_intent || null,
      metodo,
      // Desde aquí `expiraAt` es cuándo vence la FICHA, no el checkout: es
      // la fecha que se le muestra a la vendedora y la que marca cuándo
      // cancelar la venta si no paga.
      ...(metodo === "oxxo" ? { expiraAt: new Date(Date.now() + OXXO_DIAS * 24 * 60 * 60 * 1000) } : {}),
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
  // La ficha venció sin pago: si la venta se cerró esperándola, se cancela.
  // Salvo que el cliente haya pagado por otro link.
  if (count > 0 && estado === "FALLIDO") {
    const pagadoPorOtro = await prisma.linkPago.findFirst({ where: { leadId: link.leadId, estado: "PAGADO" } });
    if (!pagadoPorOtro) await require("./ventaPagoPendiente").cancelarVentaPorPagoVencido(link.leadId);
  }
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
  cobroDelLead,
  bloqueoPorLinkPendiente,
  cancelarLinksVivos,
  idDeCodigo,
  mensajeDelLink,
  whatsappHabilitado: whatsapp.isEnabled,
};
