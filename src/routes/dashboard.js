const express = require("express");
const authMiddleware = require("../middleware/auth");
const { LEAD_STATUSES_ABIERTOS } = require("../lib/leadStatus");
const { getParametros } = require("../lib/parametros");
const { ocultarTelefonoLeads } = require("../lib/telefono");

const router = express.Router();
const prisma = require("../lib/prisma");

// GET /api/dashboard — métricas del día y leads del vendedor
router.get("/", authMiddleware, async (req, res) => {
  try {
    const vendedorId = req.user.id;
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    const [ventasHoy, entregasExitosas, leadsPendientes, metaDiaria] = await Promise.all([
      prisma.venta.count({ where: { vendedorId, fecha: { gte: hoy } } }),
      prisma.venta.count({ where: { vendedorId, fecha: { gte: hoy }, entregaExitosa: true } }),
      prisma.lead.count({ where: { vendedorId, status: { in: LEAD_STATUSES_ABIERTOS } } }),
      getParametros(req.user.tenantId).then((p) => p.metaDiaria),
    ]);

    const leads = await prisma.lead.findMany({
      where: { vendedorId, status: { in: LEAD_STATUSES_ABIERTOS } },
      orderBy: { createdAt: "desc" },
    });

    res.json({
      metricas: {
        ventasRealizadas: ventasHoy,
        entregasExitosas,
        leadsPendientes,
        metaDiaria,
        porcentajeMeta: Math.round((ventasHoy / metaDiaria) * 100),
        conversion: ventasHoy > 0 ? Math.round((entregasExitosas / ventasHoy) * 100) : 0,
      },
      leads: await ocultarTelefonoLeads(leads, req.user),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
