const express = require("express");
const authMiddleware = require("../middleware/auth");

const router = express.Router();
const prisma = require("../lib/prisma");

// GET /api/productos
router.get("/", authMiddleware, async (req, res) => {
  try {
    const productos = await prisma.producto.findMany({
      where: { activo: true, tenantId: req.user.tenantId },
      orderBy: { nombre: "asc" },
    });
    res.json({ productos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
