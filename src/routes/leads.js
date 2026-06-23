const express = require("express");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/leads
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { status, search } = req.query;
    const vendedorId = req.user.id;

    const where = { vendedorId };
    if (status) where.status = status.toUpperCase();
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
    const { nombre, telefono, producto, cantidad, hora, categoria, notas } = req.body;
    if (!nombre || !telefono || !producto) {
      return res.status(400).json({ error: "Nombre, teléfono y producto requeridos" });
    }

    const lead = await prisma.lead.create({
      data: { nombre, telefono, producto, cantidad: cantidad || 1, hora, categoria, notas, vendedorId: req.user.id },
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

    const { nombre, telefono, producto, cantidad, hora, status, folio, monto, categoria, notas } = req.body;
    const lead = await prisma.lead.update({
      where: { id },
      data: { nombre, telefono, producto, cantidad, hora, status, folio, monto, categoria, notas },
    });
    res.json(lead);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// DELETE /api/leads/:id (archiva)
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.lead.findFirst({ where: { id, vendedorId: req.user.id } });
    if (!existing) return res.status(404).json({ error: "Lead no encontrado" });

    await prisma.lead.update({ where: { id }, data: { status: "ARCHIVADO" } });
    res.json({ message: "Lead archivado" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
