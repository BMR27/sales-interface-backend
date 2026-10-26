const express = require("express");
const authMiddleware = require("../middleware/auth");
const { requirePermiso } = require("../lib/permisosCatalog");
const { registrarResultado } = require("../lib/historialLlamadas");
const { ocultarTelefonoLead } = require("../lib/telefono");

const router = express.Router();
const prisma = require("../lib/prisma");

// GET /api/llamada/:id — info del lead para la llamada
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: parseInt(req.params.id), vendedorId: req.user.id },
      include: {
        productoCatalogo: true,
        items: { include: { producto: true } },
      },
    });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });

    const producto = lead.productoCatalogo;
    const promociones = producto?.ofertasTiers || [];

    const productos = await prisma.producto.findMany({
      where: { activo: true, tenantId: req.user.tenantId },
      orderBy: { nombre: "asc" },
    });

    res.json({
      // El numero completo no sale del servidor: el marcador manda el id del
      // lead y el webhook de TwiML resuelve a que numero llamar.
      lead: ocultarTelefonoLead(lead, req.user.rol),
      // Un lead con venta cerrada se puede consultar pero no volver a
      // vender: la dirección y la ubicación compartida se siguen
      // necesitando a la vista para completar el envío. Quien bloquea de
      // verdad la doble venta es confirmar/reagendar/rechazar, cada uno
      // con su propia guarda.
      ventaCerrada: lead.status === "VENTA",
      producto: producto
        ? { id: producto.id, nombre: producto.nombre, ofertasTexto: producto.ofertas, beneficios: producto.beneficios }
        : null,
      promociones,
      productos: productos.map((p) => ({
        id: p.id,
        nombre: p.nombre,
        sku: p.sku,
        categoria: p.categoria,
        ofertasTexto: p.ofertas,
        beneficios: p.beneficios,
        pvpLeadsCpa: p.pvpLeadsCpa,
        ofertasTiers: p.ofertasTiers || [],
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/llamada/:id/confirmar — registra resultado de la llamada (carrito de productos)
router.post("/:id/confirmar", authMiddleware, requirePermiso("vendedor.leads.confirmar_venta"), async (req, res) => {
  try {
    const leadId = parseInt(req.params.id);
    const { duracion, resultado, notas, aceptoOferta, items } = req.body;

    const lead = await prisma.lead.findFirst({
      where: { id: leadId, vendedorId: req.user.id },
    });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });
    if (lead.status === "VENTA") {
      return res.status(409).json({ error: "Este lead ya tiene una venta cerrada" });
    }

    const cartItems = Array.isArray(items) ? items : [];
    if (aceptoOferta && cartItems.length > 0) {
      for (const item of cartItems) {
        if (!item.productoId || !item.cantidad || item.precioUnitario == null) {
          return res.status(400).json({ error: "Cada producto del carrito requiere productoId, cantidad y precioUnitario" });
        }
      }
    }

    const productoNombres = cartItems.length
      ? Object.fromEntries(
          (
            await prisma.producto.findMany({
              where: { id: { in: cartItems.map((i) => i.productoId) } },
              select: { id: true, nombre: true },
            })
          ).map((p) => [p.id, p.nombre])
        )
      : {};

    const ofertas =
      aceptoOferta && cartItems.length > 0
        ? cartItems.map((i) =>
            i.esRegalo
              ? `${i.cantidad}x ${productoNombres[i.productoId] || "Producto"} - GRATIS (regalo)`
              : `${i.cantidad}x ${productoNombres[i.productoId] || "Producto"} - $${i.precioUnitario}/u`
          )
        : [];

    // Completa el intento que creó el marcador (o crea la fila si llamó por
    // fuera). El estatus no se mueve aquí: sigue pendiente hasta que la
    // venta se registre, así que `estadoDespues` es el que ya tenía.
    await registrarResultado({
      leadId,
      vendedorId: req.user.id,
      tenantId: req.user.tenantId,
      duracion,
      ofertas,
      resultado,
      notas,
      estadoAntes: lead.status,
      estadoDespues: lead.status,
    });

    if (aceptoOferta && cartItems.length > 0) {
      const montoTotal = cartItems.reduce((sum, i) => sum + i.precioUnitario * i.cantidad, 0);
      const cantidadTotal = cartItems.reduce((sum, i) => sum + i.cantidad, 0);

      await prisma.$transaction([
        prisma.leadItem.deleteMany({ where: { leadId } }),
        prisma.leadItem.createMany({
          data: cartItems.map((i) => ({
            leadId,
            productoId: i.productoId,
            cantidad: i.cantidad,
            precioUnitario: i.precioUnitario,
            esRegalo: Boolean(i.esRegalo),
            tenantId: req.user.tenantId,
          })),
        }),
        // El estatus no se mueve aquí: el lead sigue siendo un pendiente
        // hasta que la venta se registre (ahí pasa a VENTA/Concretado) o se
        // descarte. Solo se guarda lo que el cliente aceptó en el carrito.
        prisma.lead.update({
          where: { id: leadId },
          data: { monto: montoTotal, cantidad: cantidadTotal },
        }),
      ]);
    }

    res.json({ message: "Llamada registrada", leadId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/llamada/:id/reagendar — reagenda el lead para una fecha futura
router.post("/:id/reagendar", authMiddleware, requirePermiso("vendedor.leads.reagendar"), async (req, res) => {
  try {
    const leadId = parseInt(req.params.id);
    const { fecha, notas } = req.body;

    const lead = await prisma.lead.findFirst({
      where: { id: leadId, vendedorId: req.user.id },
    });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });
    if (lead.status === "VENTA") {
      return res.status(409).json({ error: "Este lead ya tiene una venta cerrada" });
    }

    if (!fecha) return res.status(400).json({ error: "Fecha requerida" });
    const fechaReagenda = new Date(fecha);
    if (Number.isNaN(fechaReagenda.getTime())) {
      return res.status(400).json({ error: "Fecha inválida" });
    }
    if (fechaReagenda.getTime() < Date.now()) {
      return res.status(400).json({ error: "La fecha de reagenda debe ser futura" });
    }

    await registrarResultado({
      leadId,
      vendedorId: req.user.id,
      tenantId: req.user.tenantId,
      resultado: "REAGENDADO",
      notas,
      estadoAntes: lead.status,
      estadoDespues: "REAGENDADO",
    });

    await prisma.lead.update({
      where: { id: leadId },
      data: { status: "REAGENDADO", fechaReagenda },
    });

    res.json({ message: "Llamada reagendada", leadId, fechaReagenda });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
