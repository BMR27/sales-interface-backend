const express = require("express");
const crypto = require("crypto");
const authMiddleware = require("../middleware/auth");
const proveedorMiddleware = require("../middleware/proveedor");
const { hashKey } = require("../middleware/apiKey");
const { rangoFechas, inicioDeMes } = require("../lib/fechasLocales");
const {
  apiKeyIdsDe, comentariosDeLead, resumirCalidad, desenlaceDe, puedeVerNotas, INCLUDE_COMENTARIOS,
} = require("../lib/reporteProveedor");

const router = express.Router();
const prisma = require("../lib/prisma");

router.use(authMiddleware, proveedorMiddleware);

// GET /api/proveedor/api-key — metadata de la key propia (si existe), sin exponer el valor completo
router.get("/api-key", async (req, res) => {
  try {
    const apiKey = await prisma.apiKey.findFirst({
      where: { createdByUserId: req.user.id, tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
      select: { id: true, label: true, keyPrefix: true, active: true, createdAt: true, lastUsedAt: true },
    });
    res.json({ apiKey: apiKey || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/proveedor/api-key — genera (o regenera, revocando la anterior) la key propia del proveedor
router.post("/api-key", async (req, res) => {
  try {
    await prisma.apiKey.updateMany({
      where: { createdByUserId: req.user.id, tenantId: req.user.tenantId, active: true },
      data: { active: false },
    });

    const fullKey = `sk_${crypto.randomBytes(24).toString("hex")}`;
    const apiKey = await prisma.apiKey.create({
      data: {
        label: `Proveedor de leads - ${req.user.nombre}`,
        keyPrefix: fullKey.slice(0, 12),
        keyHash: hashKey(fullKey),
        tenantId: req.user.tenantId,
        createdByUserId: req.user.id,
      },
    });

    res.status(201).json({
      id: apiKey.id,
      label: apiKey.label,
      keyPrefix: apiKey.keyPrefix,
      key: fullKey,
      createdAt: apiKey.createdAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// Rango por defecto del portal: el mes corrido. Suficiente para ver como va
// la base sin que la primera carga tenga que recorrer todo el historico.
function rangoDelPortal(req) {
  const { desde, hasta } = req.query;
  return rangoFechas(desde, hasta) ?? { gte: inicioDeMes(new Date()) };
}

// GET /api/proveedor/resumen — como se porto la base que mando este
// proveedor. Es la pantalla que contesta "de lo que te mande, que sirvio".
router.get("/resumen", async (req, res) => {
  try {
    const apiKeyIds = await apiKeyIdsDe(req.user.id, req.user.tenantId);
    if (apiKeyIds.length === 0) {
      return res.json({ resumen: resumirCalidad([]), sinApiKey: true });
    }

    const leads = await prisma.incomingLead.findMany({
      where: { apiKeyId: { in: apiKeyIds }, createdAt: rangoDelPortal(req) },
      select: {
        assignedLead: { select: { status: true, motivoDescarte: true } },
      },
    });

    res.json({ resumen: resumirCalidad(leads), sinApiKey: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/proveedor/leads — los leads que mando, con su desenlace.
//
// Deliberadamente sin monto de venta, sin comision y sin quien lo atendio:
// el proveedor necesita saber si su lead sirvio, no como trabaja la
// operacion por dentro.
router.get("/leads", async (req, res) => {
  try {
    const apiKeyIds = await apiKeyIdsDe(req.user.id, req.user.tenantId);
    if (apiKeyIds.length === 0) return res.json({ leads: [], total: 0 });

    const take = Math.min(Number(req.query.limite) || 50, 200);
    const skip = Math.max(Number(req.query.offset) || 0, 0);
    const { estado, q } = req.query;

    const where = {
      apiKeyId: { in: apiKeyIds },
      createdAt: rangoDelPortal(req),
      ...(q
        ? {
            OR: [
              { folio: { contains: String(q), mode: "insensitive" } },
              { consumerName: { contains: String(q), mode: "insensitive" } },
              { phone: { contains: String(q) } },
            ],
          }
        : {}),
    };

    if (estado === "vendido") where.assignedLead = { status: "VENTA" };
    else if (estado === "descartado") where.assignedLead = { status: "DESCARTADO" };
    else if (estado === "en_proceso") where.assignedLead = { status: { in: ["NUEVO", "REAGENDADO"] } };
    else if (estado === "pendiente") where.assignedLeadId = null;

    const [filas, total] = await Promise.all([
      prisma.incomingLead.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        select: {
          id: true,
          folio: true,
          consumerName: true,
          phone: true,
          product: true,
          buyerId: true,
          createdAt: true,
          assignedLead: {
            select: { status: true, motivoDescarte: true, folioPS: true },
          },
        },
      }),
      prisma.incomingLead.count({ where }),
    ]);

    res.json({
      total,
      leads: filas.map((f) => {
        const desenlace = desenlaceDe(f.assignedLead);
        return {
          id: f.id,
          folio: f.folio,
          folioPS: f.assignedLead?.folioPS ?? null,
          cliente: f.consumerName,
          telefono: f.phone,
          producto: f.product,
          buyerId: f.buyerId,
          recibidoAt: f.createdAt,
          estado: desenlace.estado,
          detalleEstado: desenlace.detalle,
          motivoDescarte: desenlace.motivo ?? null,
          cuentaContraLaBase: desenlace.cuentaContraLaBase ?? null,
        };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/proveedor/leads/:id/comentarios — que se registro al trabajar
// ese lead: cada intento de llamada y en que termino.
router.get("/leads/:id/comentarios", async (req, res) => {
  try {
    const apiKeyIds = await apiKeyIdsDe(req.user.id, req.user.tenantId);
    if (apiKeyIds.length === 0) return res.status(404).json({ error: "Lead no encontrado" });

    // El filtro por apiKeyId es lo que impide que un proveedor consulte los
    // leads de otro cambiando el id en la URL.
    const incoming = await prisma.incomingLead.findFirst({
      where: { id: Number(req.params.id), apiKeyId: { in: apiKeyIds } },
      select: {
        folio: true,
        assignedLead: {
          select: {
            folio: true,
            folioPS: true,
            status: true,
            motivoDescarte: true,
            motivoDescarteNota: true,
            devueltoAt: true,
            devueltoMotivo: true,
            ...INCLUDE_COMENTARIOS,
          },
        },
      },
    });
    if (!incoming) return res.status(404).json({ error: "Lead no encontrado" });

    if (!incoming.assignedLead) {
      return res.json({
        folio: incoming.folio,
        estado: "pendiente",
        detalleEstado: "Recibido, aún sin asignar",
        intentos: [],
        totalIntentos: 0,
        vecesQueContesto: 0,
      });
    }

    const incluirNotas = await puedeVerNotas(req.user.tenantId);
    res.json(comentariosDeLead(incoming.assignedLead, { incluirNotas }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
