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
      include: { productoCatalogo: true },
    });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });
    if (lead.status === "VENTA") {
      return res.status(409).json({ error: "Este lead ya tiene una venta cerrada" });
    }

    const producto = lead.productoCatalogo;
    const promociones = producto?.ofertasTiers || [];

    res.json({
      lead,
      producto: producto
        ? { id: producto.id, nombre: producto.nombre, ofertasTexto: producto.ofertas, beneficios: producto.beneficios }
        : null,
      promociones,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/llamada/:id/confirmar — registra resultado de la llamada
router.post("/:id/confirmar", authMiddleware, async (req, res) => {
  try {
    const leadId = parseInt(req.params.id);
    const { duracion, resultado, notas, aceptoOferta, cantidadSeleccionada, montoSeleccionado } = req.body;

    const lead = await prisma.lead.findFirst({
      where: { id: leadId, vendedorId: req.user.id },
    });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });
    if (lead.status === "VENTA") {
      return res.status(409).json({ error: "Este lead ya tiene una venta cerrada" });
    }

    const ofertas = aceptoOferta && cantidadSeleccionada && montoSeleccionado
      ? [`${cantidadSeleccionada}x - $${montoSeleccionado}`]
      : [];

    await prisma.llamada.create({
      data: { leadId, vendedorId: req.user.id, duracion, ofertas, resultado, notas, tenantId: req.user.tenantId },
    });

    if (aceptoOferta) {
      await prisma.lead.update({
        where: { id: leadId },
        data: { status: "NEGOCIACION", cantidad: cantidadSeleccionada || lead.cantidad },
      });
    }

    const query = aceptoOferta && montoSeleccionado
      ? `?leadId=${leadId}&monto=${montoSeleccionado}&cantidad=${cantidadSeleccionada}`
      : `?leadId=${leadId}`;

    res.json({ message: "Llamada registrada", leadId, redirectTo: `/envio${query}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
