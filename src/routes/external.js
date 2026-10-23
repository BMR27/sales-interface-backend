const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { apiKeyMiddleware } = require("../middleware/apiKey");
const { getNextVendedor } = require("../lib/assignment");
const { getParametros } = require("../lib/parametros");
const { notificarLeadNuevo } = require("../lib/notificaciones");
const { detallarMovimiento } = require("../lib/auditoria");
const {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_DESCRIPCIONES,
  parseLeadStatus,
  leadStatusLabel,
} = require("../lib/leadStatus");

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

    // Por defecto el lead entra SIN vendedora y espera en la cola del
    // coordinador, que lo reparte a mano. El reparto automatico por turnos
    // queda como opcion en Configuracion > Operacion.
    const { asignacionAutomatica } = await getParametros(tenantId);
    const vendedor = asignacionAutomatica ? await getNextVendedor(prisma, tenantId) : null;

    if (asignacionAutomatica && !vendedor) {
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
        // Se guarda el nombre tal cual lo manda el proveedor, a propósito:
        // es el nombre con el que el lead llegó. Puede no coincidir con el
        // del catálogo (el proveedor manda "Prosta Vital Men" donde el
        // catálogo dice "Vital Men Balance") y así se decidió dejarlo.
        producto: product,
        categoria: category,
        folio,
        vendedorId: vendedor?.id ?? null,
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
      // Sin vendedora todavia el lead esta recibido, no asignado: el
      // proveedor lo ve como pendiente, que es la verdad.
      data: {
        status: vendedor ? "ASSIGNED" : "RECEIVED",
        assignedLeadId: lead.id,
        assignedVendedorId: vendedor?.id ?? null,
      },
    });

    detallarMovimiento(req, {
      entidadId: lead.id,
      descripcion: vendedor
        ? `Lead ${lead.nombre} recibido por API y asignado a ${vendedor.nombre}`
        : `Lead ${lead.nombre} recibido por API, pendiente de asignar`,
      despues: {
        folio, nombre: lead.nombre, telefono: lead.telefono, producto: lead.producto,
        vendedor: vendedor?.nombre ?? "sin asignar",
      },
    });

    notificarLeadNuevo(lead, { vendedor, origen: "api_externa" });

    res.status(201).json({
      received: true,
      folio,
      leadId: lead.id,
      assignedTo: vendedor ? { id: vendedor.id, nombre: vendedor.nombre } : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// `estado` es la agrupación gruesa que esta API expone desde el principio
// (vendido | pendiente | cancelado). Se mantiene por compatibilidad con los
// proveedores que ya la consumen; el estatus real del ciclo del lead va en
// `status`.
const ESTADOS_AGRUPADOS = ["vendido", "pendiente", "cancelado"];

function estadoAgrupado(leadStatus) {
  if (leadStatus === "VENTA") return "vendido";
  if (leadStatus === "DESCARTADO") return "cancelado";
  return "pendiente";
}

function serializeEstado(incomingLead) {
  const lead = incomingLead.assignedLead;

  // Un lead que nunca se pudo asignar (sin vendedores activos) no tiene
  // estatus del ciclo: no entró a la operación. Se reporta como cancelado
  // con el motivo, que es lo que el proveedor necesita saber.
  if (!lead) {
    const fallo = incomingLead.status === "FAILED";
    return {
      folio: incomingLead.folio,
      leadId: null,
      status: null,
      statusLabel: fallo ? "No asignado" : "Recibido",
      estado: fallo ? "cancelado" : "pendiente",
      detalleEstado: fallo ? incomingLead.errorMessage || "No se pudo asignar" : "RECIBIDO",
      cliente: incomingLead.consumerName,
      telefono: incomingLead.phone,
      producto: incomingLead.product,
      externalSku: incomingLead.externalSku,
      monto: null,
      fechaReagenda: null,
      vendedor: null,
      recibidoAt: incomingLead.createdAt,
      actualizadoAt: incomingLead.createdAt,
    };
  }

  return {
    folio: incomingLead.folio,
    leadId: lead.id,
    status: lead.status,
    statusLabel: leadStatusLabel(lead.status),
    estado: estadoAgrupado(lead.status),
    detalleEstado: lead.status,
    cliente: lead.nombre,
    telefono: lead.telefono,
    producto: lead.producto,
    externalSku: lead.externalSku ?? incomingLead.externalSku,
    monto: lead.venta?.monto ?? lead.monto ?? null,
    // Solo tiene valor cuando el cliente pidió que le llamaran otro día.
    fechaReagenda: lead.status === "REAGENDADO" ? lead.fechaReagenda : null,
    vendedor: lead.vendedor ? { id: lead.vendedor.id, nombre: lead.vendedor.nombre } : null,
    recibidoAt: incomingLead.createdAt,
    actualizadoAt: lead.updatedAt,
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

// GET /api/external/leads-estatus — catálogo de los estatus del ciclo, para
// que el proveedor no tenga que hardcodearlos leyendo la documentación.
router.get("/leads-estatus", apiKeyMiddleware, (req, res) => {
  res.json({
    estatus: LEAD_STATUSES.map((status) => ({
      status,
      label: LEAD_STATUS_LABELS[status],
      descripcion: LEAD_STATUS_DESCRIPCIONES[status],
      estado: estadoAgrupado(status),
    })),
  });
});

// GET /api/external/leads/:folio — estatus de un lead enviado previamente
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

// GET /api/external/leads — lista paginada de los leads enviados con esta
// API key y el estatus en que va cada uno.
//
// Filtros: ?status= (NUEVO | REAGENDADO | DESCARTADO | VENTA),
// ?estado= (vendido | pendiente | cancelado), ?desde= / ?hasta= (ISO o
// YYYY-MM-DD, sobre la fecha de recepción), ?limit= y ?skip=.
router.get("/leads", apiKeyMiddleware, async (req, res) => {
  try {
    const { status, estado, desde, hasta } = req.query;
    const take = Math.min(Number(req.query.limit) || 50, 200);
    const skip = Math.max(Number(req.query.skip) || 0, 0);

    const where = { apiKeyId: req.apiKey.id };

    if (status) {
      const parsed = parseLeadStatus(status);
      if (!parsed) {
        return res.status(400).json({ error: `status inválido. Valores: ${LEAD_STATUSES.join(", ")}` });
      }
      where.assignedLead = { status: parsed };
    }

    if (estado) {
      if (!ESTADOS_AGRUPADOS.includes(estado)) {
        return res.status(400).json({ error: `estado inválido. Valores: ${ESTADOS_AGRUPADOS.join(", ")}` });
      }
      // `estado` agrupa, así que se traduce a los estatus que lo componen.
      // "pendiente" incluye además los leads que todavía no se asignaron
      // (no tienen lead), de ahí el OR.
      const incluidos = LEAD_STATUSES.filter((s) => estadoAgrupado(s) === estado);
      if (estado === "pendiente") {
        where.OR = [
          { assignedLead: { status: { in: incluidos } } },
          { assignedLeadId: null, status: { not: "FAILED" } },
        ];
      } else if (estado === "cancelado") {
        where.OR = [
          { assignedLead: { status: { in: incluidos } } },
          { assignedLeadId: null, status: "FAILED" },
        ];
      } else {
        where.assignedLead = { ...(where.assignedLead || {}), status: { in: incluidos } };
      }
    }

    const createdAt = {};
    if (desde) {
      const d = new Date(desde.length === 10 ? `${desde}T00:00:00` : desde);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: "desde inválido" });
      createdAt.gte = d;
    }
    if (hasta) {
      const h = new Date(hasta.length === 10 ? `${hasta}T23:59:59` : hasta);
      if (Number.isNaN(h.getTime())) return res.status(400).json({ error: "hasta inválido" });
      createdAt.lte = h;
    }
    if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;

    const [incomingLeads, total] = await Promise.all([
      prisma.incomingLead.findMany({
        where,
        include: LEAD_INCLUDE,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.incomingLead.count({ where }),
    ]);

    res.json({ leads: incomingLeads.map(serializeEstado), total, limit: take, skip });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/external/entregas — aviso de FullVector cuando una orden se
// entrega exitosamente (el reverso de la venta que creó esa orden allá).
// Autenticado por X-API-Key, igual que el resto de /api/external.
router.post("/entregas", apiKeyMiddleware, async (req, res) => {
  try {
    const { folio, status } = req.body || {};
    if (!folio) return res.status(400).json({ error: "folio requerido" });

    const venta = await prisma.venta.findFirst({
      where: { folio, tenantId: req.apiKey.tenantId },
    });
    if (!venta) return res.status(404).json({ error: "Venta no encontrada para ese folio" });

    if (status === "SUCCESSFUL_DELIVERY") {
      await prisma.venta.update({ where: { id: venta.id }, data: { entregaExitosa: true } });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
