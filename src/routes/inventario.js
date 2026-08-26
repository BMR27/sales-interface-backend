const express = require("express");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");

const router = express.Router();
const prisma = new PrismaClient();

router.use(authMiddleware, adminMiddleware);

const LOW_STOCK_THRESHOLD = 10;

// GET /api/admin/inventario — stock actual por producto
router.get("/", async (req, res) => {
  try {
    const productos = await prisma.producto.findMany({
      where: { activo: true, tenantId: req.user.tenantId },
      orderBy: { nombre: "asc" },
    });

    const items = productos.map((p) => ({
      id: p.id,
      sku: p.sku,
      nombre: p.nombre,
      categoria: p.categoria,
      stock: p.stock,
      status: p.stock <= 0 ? "AGOTADO" : p.stock <= LOW_STOCK_THRESHOLD ? "BAJO" : "OK",
    }));

    res.json({
      items,
      resumen: {
        totalProductos: items.length,
        agotados: items.filter((i) => i.status === "AGOTADO").length,
        bajos: items.filter((i) => i.status === "BAJO").length,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/inventario/movimientos — historial de movimientos
router.get("/movimientos", async (req, res) => {
  try {
    const { productoId } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (productoId) where.productoId = parseInt(productoId);

    const movimientos = await prisma.movimientoInventario.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { producto: { select: { nombre: true, sku: true } } },
    });

    res.json({ movimientos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/admin/inventario/ajuste — entrada, salida o ajuste manual de stock
router.post("/ajuste", async (req, res) => {
  try {
    const { productoId, tipo, cantidad, motivo } = req.body;
    if (!productoId || !tipo || cantidad == null) {
      return res.status(400).json({ error: "productoId, tipo y cantidad son requeridos" });
    }
    if (!["ENTRADA", "SALIDA", "AJUSTE"].includes(tipo)) {
      return res.status(400).json({ error: "tipo inválido" });
    }

    const producto = await prisma.producto.findFirst({ where: { id: productoId, tenantId: req.user.tenantId } });
    if (!producto) return res.status(404).json({ error: "Producto no encontrado" });

    let nuevoStock;
    let cantidadMovimiento;
    if (tipo === "ENTRADA") {
      nuevoStock = producto.stock + Math.abs(cantidad);
      cantidadMovimiento = Math.abs(cantidad);
    } else if (tipo === "SALIDA") {
      nuevoStock = producto.stock - Math.abs(cantidad);
      cantidadMovimiento = -Math.abs(cantidad);
    } else {
      nuevoStock = cantidad;
      cantidadMovimiento = cantidad - producto.stock;
    }

    const [productoActualizado, movimiento] = await prisma.$transaction([
      prisma.producto.update({ where: { id: productoId }, data: { stock: nuevoStock } }),
      prisma.movimientoInventario.create({
        data: {
          productoId,
          tipo,
          cantidad: cantidadMovimiento,
          stockResultante: nuevoStock,
          motivo: motivo || null,
          tenantId: req.user.tenantId,
        },
      }),
    ]);

    res.status(201).json({ producto: productoActualizado, movimiento });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
