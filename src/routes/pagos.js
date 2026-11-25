// Links de pago de Stripe (ver src/lib/linksPago.js).
//
// Los manda la vendedora a media llamada, sobre su propio lead, y la
// coordinadora o el admin desde el expediente de prepago.
const express = require("express");
const authMiddleware = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { filtroLead } = require("../lib/accesoLead");
const {
  isEnabled, getStripe, MONTO_MINIMO, serializarLink, crearYEnviarLink, procesarEventoStripe,
  cancelarLinksVivos, whatsappHabilitado,
} = require("../lib/linksPago");

const router = express.Router();

// Quienes gestionan prepago (ver src/routes/prepago.js) cobran sobre
// cualquier lead de su espacio; los demás, sobre los que filtroLead les da.
const ROLES_GESTORES = ["ADMIN", "ADMIN_OPERATIVO", "COORDINADOR"];

function filtroCobro(user, leadId) {
  if (ROLES_GESTORES.includes(user.rol)) return { id: leadId, tenantId: user.tenantId };
  return filtroLead(user, leadId);
}

// GET /api/pagos/lead/:leadId/links — los links del lead, el más nuevo primero
router.get("/lead/:leadId/links", authMiddleware, async (req, res) => {
  try {
    const leadId = parseInt(req.params.leadId);
    const lead = await prisma.lead.findFirst({ where: filtroCobro(req.user, leadId), select: { id: true } });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });

    const links = await prisma.linkPago.findMany({ where: { leadId }, orderBy: { createdAt: "desc" } });
    res.json({ habilitado: isEnabled(), whatsapp: whatsappHabilitado(), links: links.map(serializarLink) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/pagos/lead/:leadId/link — crea el checkout y lo manda por SMS.
//
// Body: { monto, forzar }. Si el lead ya tiene venta el monto sale de ella
// (producto más flete) y el del body se ignora. En media llamada todavía no
// hay venta: el monto es el total del carrito que la vendedora tiene en
// pantalla.
router.post("/lead/:leadId/link", authMiddleware, async (req, res) => {
  try {
    if (!isEnabled()) return res.status(503).json({ error: "El cobro con Stripe no está configurado" });
    if (!process.env.FRONTEND_URL) return res.status(503).json({ error: "FRONTEND_URL no configurado" });

    const leadId = parseInt(req.params.leadId);
    const lead = await prisma.lead.findFirst({ where: filtroCobro(req.user, leadId), include: { venta: true } });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });
    if (!lead.telefono) return res.status(400).json({ error: "El lead no tiene teléfono" });
    const canal = req.body?.canal === "whatsapp" ? "whatsapp" : "sms";
    if (canal === "whatsapp" && !whatsappHabilitado()) {
      return res.status(400).json({ error: "El envío por WhatsApp todavía no está configurado" });
    }
    // Una venta que ya salió con cobro contra entrega no se cobra también
    // por link: el mensajero cobraría el monto completo otra vez. Sin
    // cobertura (o ya prepagada) sí: ahí el link es como se cobra.
    if (lead.venta && !lead.venta.prepagada && !lead.venta.fullvectorSinCobertura && lead.coberturaFv !== false) {
      return res.status(409).json({
        error: "Esta venta ya se registró con pago contra entrega: el mensajero va a cobrarla al entregar. Si el cliente quiere pagar en línea, hay que cancelar el cobro en FullVector primero.",
      });
    }

    const monto = lead.venta
      ? lead.venta.monto + (lead.venta.costoEnvio || 0)
      : Math.round(Number(req.body?.monto) * 100) / 100;
    if (!Number.isFinite(monto) || monto < MONTO_MINIMO) {
      return res.status(400).json({ error: `El monto a cobrar debe ser de al menos $${MONTO_MINIMO}` });
    }

    const previos = await prisma.linkPago.findMany({
      where: { leadId, estado: { in: ["PAGADO", "PENDIENTE_PAGO"] } },
    });
    if (previos.some((l) => l.estado === "PAGADO")) {
      return res.status(409).json({ error: "Este cliente ya pagó con un link anterior" });
    }
    // Con una ficha OXXO o una CLABE en la mano el cliente todavía puede
    // pagar el link anterior: otro link abre la puerta a cobrarle dos veces.
    if (previos.length > 0 && !req.body?.forzar) {
      return res.status(409).json({
        error: "El cliente ya generó una ficha OXXO o una CLABE con el link anterior y todavía puede pagarla. Si le mandas otro, podría pagar dos veces.",
        requiereConfirmacion: true,
      });
    }

    const link = await crearYEnviarLink({ lead, monto, user: req.user, canal });
    res.status(201).json(serializarLink(link));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.type?.startsWith?.("Stripe") ? `Stripe: ${err.message}` : "Error al crear el link de pago" });
  }
});

// POST /api/pagos/lead/:leadId/link/cancelar — el cliente prefirió pagar
// contra entrega. Vence el checkout que no abrió y anula la ficha OXXO o la
// CLABE que ya tenga, para que no pueda pagar el link y además en efectivo.
router.post("/lead/:leadId/link/cancelar", authMiddleware, async (req, res) => {
  try {
    if (!isEnabled()) return res.status(503).json({ error: "El cobro con Stripe no está configurado" });
    const leadId = parseInt(req.params.leadId);
    const lead = await prisma.lead.findFirst({ where: filtroCobro(req.user, leadId), select: { id: true } });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });

    const { cancelados, noCancelados } = await cancelarLinksVivos(leadId);
    if (noCancelados.length > 0) {
      return res.status(409).json({
        error: "Stripe no dejó cancelar el link: el pago ya se está procesando. Espera a que se confirme antes de cerrar la venta.",
        cancelados,
      });
    }
    res.json({ cancelados });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo cancelar el link de pago" });
  }
});

// POST /api/pagos/stripe/webhook — se monta en src/index.js ANTES de
// express.json(): la firma de Stripe se verifica contra el cuerpo crudo, y
// una vez parseado ya no se puede reconstruir byte por byte.
async function stripeWebhook(req, res) {
  if (!isEnabled() || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: "Stripe no configurado" });
  }
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("webhook de stripe con firma invalida", err.message);
    return res.status(400).json({ error: "Firma inválida" });
  }
  try {
    await procesarEventoStripe(event);
    res.json({ received: true });
  } catch (err) {
    // 500 a propósito: Stripe reintenta, y las transiciones son idempotentes.
    console.error("no se pudo procesar el evento de stripe", event.type, event.id, err);
    res.status(500).json({ error: "Error al procesar el evento" });
  }
}

module.exports = router;
module.exports.stripeWebhook = stripeWebhook;
