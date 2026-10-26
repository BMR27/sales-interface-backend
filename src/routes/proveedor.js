const express = require("express");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");
const proveedorMiddleware = require("../middleware/proveedor");
const { hashKey } = require("../middleware/apiKey");

const router = express.Router();
const prisma = new PrismaClient();

router.use(authMiddleware, proveedorMiddleware);

// GET /api/proveedor/api-key — metadata de la key propia (si existe), sin exponer el valor completo
router.get("/api-key", async (req, res) => {
  try {
    const apiKey = await prisma.apiKey.findFirst({
      where: { createdByUserId: req.user.id, tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
      select: { id: true, label: true, keyPrefix: true, active: true, createdAt: true, lastUsedAt: true },
    });
    res.json({ apiKey: apiKey || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/proveedor/api-key — genera (o regenera, revocando la anterior) la key propia del proveedor
router.post("/api-key", async (req, res) => {
  try {
    await prisma.apiKey.updateMany({
      where: { createdByUserId: req.user.id, tenantId: req.user.tenantId, active: true },
      data: { active: false },
    });

    const fullKey = `sk_${crypto.randomBytes(24).toString("hex")}`;
    const apiKey = await prisma.apiKey.create({
      data: {
        label: `Proveedor de leads - ${req.user.nombre}`,
        keyPrefix: fullKey.slice(0, 12),
        keyHash: hashKey(fullKey),
        tenantId: req.user.tenantId,
        createdByUserId: req.user.id,
      },
    });

    res.status(201).json({
      id: apiKey.id,
      label: apiKey.label,
      keyPrefix: apiKey.keyPrefix,
      key: fullKey,
      createdAt: apiKey.createdAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
