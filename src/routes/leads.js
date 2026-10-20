const express = require("express");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");
const { requirePermiso } = require("../lib/permisosCatalog");
const { isEnabled: smsEnabled, sendSms } = require("../lib/twilioSms");
const { LEAD_STATUSES, parseLeadStatus } = require("../lib/leadStatus");

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/leads
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { status, search } = req.query;
    const vendedorId = req.user.id;

    const where = { vendedorId };
    if (status) {
      const parsed = parseLeadStatus(status);
      if (!parsed) {
        return res.status(400).json({ error: `status inválido. Valores: ${LEAD_STATUSES.join(", ")}` });
      }
      where.status = parsed;
    }
    if (search) {
      where.OR = [
        { nombre: { contains: search, mode: "insensitive" } },
        { producto: { contains: search, mode: "insensitive" } },
      ];
    }

    const leads = await prisma.lead.findMany({
      where,
      orderBy: { updatedAt: "desc" },
    });

    const counts = await prisma.lead.groupBy({
      by: ["status"],
      where: { vendedorId },
      _count: true,
    });

    const totalMonto = await prisma.lead.aggregate({
      where: { vendedorId, status: "VENTA" },
      _sum: { monto: true },
    });

    res.json({
      leads,
      counts: counts.reduce((acc, c) => ({ ...acc, [c.status]: c._count }), {}),
      totalVentas: totalMonto._sum.monto || 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/leads/:id
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: parseInt(req.params.id), vendedorId: req.user.id },
    });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });
    res.json(lead);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/leads
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { nombre, apellido, edad, telefono, producto, cantidad, hora, categoria, notas, productoId, country, city, ip } = req.body;
    if (!nombre || !telefono || !producto) {
      return res.status(400).json({ error: "Nombre, teléfono y producto requeridos" });
    }

    const lead = await prisma.lead.create({
      data: {
        nombre, apellido: apellido || null, edad: edad ? Number(edad) : null,
        telefono, producto, cantidad: cantidad || 1, hora, categoria, notas,
        country: country || null, city: city || null, ip: ip || null,
        productoId: productoId || null,
        vendedorId: req.user.id,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(lead);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// PUT /api/leads/:id
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.lead.findFirst({ where: { id, vendedorId: req.user.id } });
    if (!existing) return res.status(404).json({ error: "Lead no encontrado" });

    const {
      nombre, telefono, producto, cantidad, hora, status, folio, monto, categoria, notas,
      shippingStreet, shippingNumber, shippingReferences, zipCode, state, colonia, municipio, lat, lng,
    } = req.body;

    if (status != null && !parseLeadStatus(status)) {
      return res.status(400).json({ error: `status inválido. Valores: ${LEAD_STATUSES.join(", ")}` });
    }

    const lead = await prisma.lead.update({
      where: { id },
      data: {
        nombre, telefono, producto, cantidad, hora, status, folio, monto, categoria, notas,
        shippingStreet, shippingNumber, shippingReferences, zipCode, state, colonia, municipio, lat, lng,
      },
    });

    // Si la dirección de envío quedó completa y la venta se había marcado
    // FAILED por eso (ver src/lib/fullvector.js), se reintenta sola en vez
    // de dejarla atorada -- quien edite el lead no tiene por qué saber que
    // existe una sincronización con FullVector.
    if (lead.shippingStreet && lead.shippingNumber) {
      const venta = await prisma.venta.findUnique({ where: { leadId: id } });
      if (venta && venta.fullvectorSyncStatus === "FAILED") {
        await prisma.venta.update({
          where: { id: venta.id },
          data: { fullvectorSyncStatus: "PENDING", fullvectorAttempts: 0, fullvectorError: null },
        });
        require("../lib/fullvector").syncVentaToFullVector(venta.id).catch((err) => {
          console.error("fullvector resync error, venta", venta.id, err);
        });
      }
    }

    res.json(lead);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// DELETE /api/leads/:id (archiva)
router.delete("/:id", authMiddleware, requirePermiso("vendedor.leads.rechazar"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.lead.findFirst({ where: { id, vendedorId: req.user.id } });
    if (!existing) return res.status(404).json({ error: "Lead no encontrado" });

    await prisma.lead.update({ where: { id }, data: { status: "DESCARTADO" } });
    res.json({ message: "Lead descartado" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/leads/:id/ticket-sms — manda el ticket de compra (folio, monto)
// por SMS desde el número de la empresa (no WhatsApp personal, ver
// src/lib/twilioSms.js).
router.post("/:id/ticket-sms", authMiddleware, async (req, res) => {
  try {
    if (!smsEnabled()) return res.status(503).json({ error: "Envío de SMS no configurado" });

    const id = parseInt(req.params.id);
    const lead = await prisma.lead.findFirst({
      where: { id, vendedorId: req.user.id },
      include: { venta: true },
    });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });
    if (!lead.telefono) return res.status(400).json({ error: "El lead no tiene teléfono" });
    if (!lead.venta) return res.status(400).json({ error: "Este lead aún no tiene una venta registrada" });

    const mensaje = `¡Gracias por tu compra, ${lead.nombre}! Folio: ${lead.folio ?? lead.venta.folio ?? "-"}. Producto: ${lead.producto} (x${lead.cantidad}). Total: $${lead.venta.monto + (lead.venta.costoEnvio || 0)}. En breve recibirás tu pedido.`;

    await sendSms(lead.telefono, mensaje);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al enviar el SMS" });
  }
});

// POST /api/leads/:id/solicitar-ubicacion — SMS con link a una página
// pública (app/compartir-ubicacion/[token]) donde el cliente comparte su
// ubicación desde el navegador -- reemplaza el wa.me que dependía del
// WhatsApp personal de la vendedora.
router.post("/:id/solicitar-ubicacion", authMiddleware, async (req, res) => {
  try {
    if (!smsEnabled()) return res.status(503).json({ error: "Envío de SMS no configurado" });
    if (!process.env.FRONTEND_URL) return res.status(503).json({ error: "FRONTEND_URL no configurado" });

    const id = parseInt(req.params.id);
    const lead = await prisma.lead.findFirst({ where: { id, vendedorId: req.user.id } });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });
    if (!lead.telefono) return res.status(400).json({ error: "El lead no tiene teléfono" });

    const token = crypto.randomBytes(16).toString("hex");
    await prisma.lead.update({
      where: { id },
      // ubicacionCompartidaAt se limpia para que una solicitud nueva no
      // arrastre la respuesta de la anterior y parezca ya contestada.
      data: { ubicacionToken: token, ubicacionSolicitadaAt: new Date(), ubicacionCompartidaAt: null },
    });

    const link = `${process.env.FRONTEND_URL}/compartir-ubicacion/${token}`;
    const mensaje = `Hola ${lead.nombre}, para completar tu entrega compártenos tu ubicación: ${link}`;
    await sendSms(lead.telefono, mensaje);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al enviar el SMS" });
  }
});

module.exports = router;
