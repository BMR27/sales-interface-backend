const express = require("express");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/llamada/:id — info del lead para la llamada
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: parseInt(req.params.id), vendedorId: req.user.id },
    });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });

    const ofertas = [
      { id: 1, titulo: "Cobertura Premium", descripcion: "Mayor protección y beneficios adicionales", descuento: 30 },
      { id: 2, titulo: "Asistencia Vial", descripcion: "Auxilio en carretera y emergencias 24/7", descuento: 30 },
    ];

    res.json({ lead, ofertas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/llamada/:id/confirmar — registra resultado de la llamada
router.post("/:id/confirmar", authMiddleware, async (req, res) => {
  try {
    const leadId = parseInt(req.params.id);
    const { duracion, ofertas, resultado, notas, aceptoOferta } = req.body;

    const lead = await prisma.lead.findFirst({
      where: { id: leadId, vendedorId: req.user.id },
    });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });

    await prisma.llamada.create({
      data: { leadId, vendedorId: req.user.id, duracion, ofertas: ofertas || [], resultado, notas },
    });

    if (aceptoOferta) {
      await prisma.lead.update({ where: { id: leadId }, data: { status: "NEGOCIACION" } });
    }

    res.json({ message: "Llamada registrada", leadId, redirectTo: `/envio?leadId=${leadId}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
