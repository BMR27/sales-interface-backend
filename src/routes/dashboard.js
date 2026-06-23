const express = require("express");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/dashboard — métricas del día y leads del vendedor
router.get("/", authMiddleware, async (req, res) => {
  try {
    const vendedorId = req.user.id;
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    const [ventasHoy, entregasExitosas, leadsPendientes, metaDiaria] = await Promise.all([
      prisma.venta.count({ where: { vendedorId, fecha: { gte: hoy } } }),
      prisma.venta.count({ where: { vendedorId, fecha: { gte: hoy }, entregaExitosa: true } }),
      prisma.lead.count({ where: { vendedorId, status: { in: ["NUEVO", "SEGUIMIENTO", "NEGOCIACION"] } } }),
      Promise.resolve(40),
    ]);

    const leads = await prisma.lead.findMany({
      where: { vendedorId, status: { not: "ARCHIVADO" } },
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
      leads,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
