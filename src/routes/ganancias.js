const express = require("express");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/ganancias
router.get("/", authMiddleware, async (req, res) => {
  try {
    const vendedorId = req.user.id;
    const ahora = new Date();

    const inicioDia = new Date(ahora); inicioDia.setHours(0, 0, 0, 0);
    const inicioSemana = new Date(ahora); inicioSemana.setDate(ahora.getDate() - ahora.getDay()); inicioSemana.setHours(0, 0, 0, 0);
    const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);

    const [hoy, semana, mes, recientes] = await Promise.all([
      prisma.venta.aggregate({ where: { vendedorId, fecha: { gte: inicioDia } }, _sum: { monto: true, comision: true } }),
      prisma.venta.aggregate({ where: { vendedorId, fecha: { gte: inicioSemana } }, _sum: { monto: true, comision: true } }),
      prisma.venta.aggregate({ where: { vendedorId, fecha: { gte: inicioMes } }, _sum: { monto: true, comision: true } }),
      prisma.venta.findMany({
        where: { vendedorId },
        include: { lead: { select: { producto: true } } },
        orderBy: { fecha: "desc" },
        take: 10,
      }),
    ]);

    const comisionPorcentaje = 15;
    const metaMensual = 120000;

    res.json({
      hoy: { monto: hoy._sum.monto || 0, comision: hoy._sum.comision || 0 },
      semana: { monto: semana._sum.monto || 0, comision: semana._sum.comision || 0 },
      mes: { monto: mes._sum.monto || 0, comision: mes._sum.comision || 0 },
      metaMensual,
      comisionPorcentaje,
      recientes: recientes.map(v => ({
        fecha: v.fecha,
        producto: v.lead.producto,
        monto: v.monto,
        comision: v.comision,
        folio: v.folio,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/ganancias/venta — registrar venta cerrada
router.post("/venta", authMiddleware, async (req, res) => {
  try {
    const { leadId, monto, folio, entregaExitosa } = req.body;
    if (!leadId || !monto) {
      return res.status(400).json({ error: "leadId y monto requeridos" });
    }

    const comisionPorcentaje = 15;
    const comision = monto * (comisionPorcentaje / 100);

    const venta = await prisma.venta.create({
      data: { leadId, vendedorId: req.user.id, monto, comision, folio, entregaExitosa: entregaExitosa || false },
    });

    await prisma.lead.update({
      where: { id: leadId },
      data: { status: "VENTA", monto, folio },
    });

    res.status(201).json(venta);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
