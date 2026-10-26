const express = require("express");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");
const { hashKey } = require("../middleware/apiKey");

const router = express.Router();
const prisma = new PrismaClient();

router.use(authMiddleware, adminMiddleware);

// GET /api/admin/api-keys
router.get("/", async (req, res) => {
  try {
    const keys = await prisma.apiKey.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
      select: { id: true, label: true, keyPrefix: true, active: true, createdAt: true, lastUsedAt: true },
    });
    res.json({ keys });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/admin/api-keys
router.post("/", async (req, res) => {
  try {
    const { label } = req.body;
    if (!label) return res.status(400).json({ error: "label requerido" });

    const fullKey = `sk_${crypto.randomBytes(24).toString("hex")}`;
    const apiKey = await prisma.apiKey.create({
      data: {
        label,
        keyPrefix: fullKey.slice(0, 12),
        keyHash: hashKey(fullKey),
        tenantId: req.user.tenantId,
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

// DELETE /api/admin/api-keys/:id — revoca (soft delete)
router.delete("/:id", async (req, res) => {
  try {
    const result = await prisma.apiKey.updateMany({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
      data: { active: false },
    });
    if (result.count === 0) return res.status(404).json({ error: "API key no encontrada" });
    res.json({ message: "API key revocada", id: parseInt(req.params.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// DELETE /api/admin/api-keys/:id/permanente — elimina definitivamente una key ya revocada (y su historial de ingestión)
router.delete("/:id/permanente", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const apiKey = await prisma.apiKey.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!apiKey) return res.status(404).json({ error: "API key no encontrada" });
    if (apiKey.active) return res.status(400).json({ error: "Revoca la key antes de eliminarla" });

    await prisma.$transaction([
      prisma.incomingLead.deleteMany({ where: { apiKeyId: id } }),
      prisma.apiKey.delete({ where: { id } }),
    ]);

    res.json({ message: "API key eliminada", id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
