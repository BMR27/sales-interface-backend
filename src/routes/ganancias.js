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

    const lead = await prisma.lead.findFirst({ where: { id: leadId, vendedorId: req.user.id } });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });

    const ventaExistente = await prisma.venta.findUnique({ where: { leadId } });
    if (ventaExistente) {
      return res.status(409).json({ error: "Este lead ya tiene una venta registrada" });
    }

    const comisionPorcentaje = 15;
    const comision = monto * (comisionPorcentaje / 100);

    let venta = await prisma.venta.create({
      data: {
        leadId, vendedorId: req.user.id, monto, comision,
        folio: folio || null, entregaExitosa: entregaExitosa || false,
        tenantId: req.user.tenantId,
      },
    });

    let finalFolio = folio;
    if (!finalFolio) {
      finalFolio = `PS${new Date().getFullYear()}-${String(venta.id).padStart(5, "0")}`;
      venta = await prisma.venta.update({ where: { id: venta.id }, data: { folio: finalFolio } });
    }

    await prisma.lead.update({
      where: { id: leadId },
      data: { status: "VENTA", monto, folio: finalFolio },
    });

    if (lead.productoId) {
      const producto = await prisma.producto.findUnique({ where: { id: lead.productoId } });
      if (producto) {
        const cantidad = lead.cantidad || 1;
        const nuevoStock = producto.stock - cantidad;
        await prisma.$transaction([
          prisma.producto.update({ where: { id: producto.id }, data: { stock: nuevoStock } }),
          prisma.movimientoInventario.create({
            data: {
              productoId: producto.id,
              tipo: "SALIDA",
              cantidad: -cantidad,
              stockResultante: nuevoStock,
              motivo: `Venta #${finalFolio}`,
              tenantId: req.user.tenantId,
              ventaId: venta.id,
            },
          }),
        ]);
      }
    }

    res.status(201).json(venta);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
