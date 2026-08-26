const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { apiKeyMiddleware } = require("../middleware/apiKey");
const { getNextVendedor } = require("../lib/assignment");

const router = express.Router();
const prisma = new PrismaClient();

const REQUIRED_FIELDS = [
  "folio",
  "phone",
  "country",
  "category",
  "product",
  "externalSku",
];

// GET /api/external/productos — catálogo consultable (SKU, categoría, precios, promociones), autenticado por X-API-Key
router.get("/productos", apiKeyMiddleware, async (req, res) => {
  try {
    const productos = await prisma.producto.findMany({
      where: { activo: true, tenantId: req.apiKey.tenantId },
      orderBy: { nombre: "asc" },
      select: {
        sku: true,
        nombre: true,
        producto: true,
        linea: true,
        categoria: true,
        subcategoria: true,
        presentacion: true,
        capacidad: true,
        pvpRetail: true,
        pvpLeadsCpa: true,
        ofertas: true,
        ofertasTiers: true,
        beneficios: true,
      },
    });

    res.json({ productos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/external/leads — recepción pública de leads (autenticado por X-API-Key)
router.post("/leads", apiKeyMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    const missing = REQUIRED_FIELDS.filter((field) => !body[field]);
    if (missing.length > 0) {
      return res.status(400).json({ error: `Campos requeridos faltantes: ${missing.join(", ")}` });
    }

    const {
      folio, consumerName, phone, country, state, zipCode,
      category, product, internalSku, externalSku,
      firstName, lastName, age, city, ip,
    } = body;

    const nombreCompleto = consumerName || [firstName, lastName].filter(Boolean).join(" ").trim();
    if (!nombreCompleto) {
      return res.status(400).json({ error: "Envía consumerName, o firstName y lastName" });
    }

    const tenantId = req.apiKey.tenantId;

    const incomingLead = await prisma.incomingLead.create({
      data: {
        folio, consumerName: nombreCompleto, phone, country, state, zipCode,
        category, product, internalSku, externalSku,
        rawPayload: body,
        apiKeyId: req.apiKey.id,
        tenantId,
      },
    });

    const vendedor = await getNextVendedor(prisma, tenantId);

    if (!vendedor) {
      await prisma.incomingLead.update({
        where: { id: incomingLead.id },
        data: { status: "FAILED", errorMessage: "No hay vendedores activos disponibles" },
      });
      return res.status(201).json({ received: true, folio, leadId: null, assignedTo: null });
    }

    const productoCatalogo = internalSku
      ? await prisma.producto.findFirst({ where: { sku: internalSku, tenantId } })
      : null;

    const lead = await prisma.lead.create({
      data: {
        nombre: nombreCompleto,
        apellido: lastName || null,
        edad: Number.isFinite(Number(age)) && age !== "" && age != null ? Number(age) : null,
        telefono: phone,
        producto: product,
        categoria: category,
        folio,
        vendedorId: vendedor.id,
        source: "EXTERNAL_API",
        country,
        city: city || null,
        ip: ip || null,
        state,
        zipCode,
        internalSku,
        externalSku,
        productoId: productoCatalogo?.id ?? null,
        tenantId,
      },
    });

    await prisma.incomingLead.update({
      where: { id: incomingLead.id },
      data: { status: "ASSIGNED", assignedLeadId: lead.id, assignedVendedorId: vendedor.id },
    });

    res.status(201).json({
      received: true,
      folio,
      leadId: lead.id,
      assignedTo: { id: vendedor.id, nombre: vendedor.nombre },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

function estadoDeLead(incomingLead) {
  if (incomingLead.status === "FAILED") {
    return { estado: "cancelado", detalle: incomingLead.errorMessage || "No se pudo asignar" };
  }
  if (!incomingLead.assignedLead) {
    return { estado: "pendiente", detalle: "RECIBIDO" };
  }
  const leadStatus = incomingLead.assignedLead.status;
  if (leadStatus === "VENTA") return { estado: "vendido", detalle: leadStatus };
  if (leadStatus === "ARCHIVADO") return { estado: "cancelado", detalle: leadStatus };
  return { estado: "pendiente", detalle: leadStatus };
}

function serializeEstado(incomingLead) {
  const { estado, detalle } = estadoDeLead(incomingLead);
  return {
    folio: incomingLead.folio,
    estado,
    detalleEstado: detalle,
    monto: incomingLead.assignedLead?.venta?.monto ?? null,
    vendedor: incomingLead.assignedLead?.vendedor
      ? { id: incomingLead.assignedLead.vendedor.id, nombre: incomingLead.assignedLead.vendedor.nombre }
      : null,
    recibidoAt: incomingLead.createdAt,
    actualizadoAt: incomingLead.assignedLead?.updatedAt ?? incomingLead.createdAt,
  };
}

const LEAD_INCLUDE = {
  assignedLead: {
    include: {
      venta: { select: { monto: true } },
      vendedor: { select: { id: true, nombre: true } },
    },
  },
};

// GET /api/external/leads/:folio — estado de un lead enviado previamente (vendido | pendiente | cancelado)
router.get("/leads/:folio", apiKeyMiddleware, async (req, res) => {
  try {
    const incomingLead = await prisma.incomingLead.findFirst({
      where: { apiKeyId: req.apiKey.id, folio: req.params.folio },
      include: LEAD_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
    if (!incomingLead) return res.status(404).json({ error: "Folio no encontrado" });

    res.json(serializeEstado(incomingLead));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/external/leads — lista paginada del estado de los leads enviados con esta API key
router.get("/leads", apiKeyMiddleware, async (req, res) => {
  try {
    const { estado } = req.query;
    const take = Math.min(Number(req.query.limit) || 50, 200);

    const incomingLeads = await prisma.incomingLead.findMany({
      where: { apiKeyId: req.apiKey.id },
      include: LEAD_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: take * 3, // margen para poder filtrar por estado derivado en memoria
    });

    let items = incomingLeads.map(serializeEstado);
    if (estado) items = items.filter((i) => i.estado === estado);

    res.json({ leads: items.slice(0, take) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
