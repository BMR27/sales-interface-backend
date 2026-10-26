const express = require("express");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");

const router = express.Router();
const prisma = require("../lib/prisma");

router.use(authMiddleware, adminMiddleware);

// GET /api/admin/monitoreo/errores
router.get("/errores", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const errores = await prisma.errorLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    res.json({ errores });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/monitoreo/memoria?horas=24
router.get("/memoria", async (req, res) => {
  try {
    const horas = Math.min(Number(req.query.horas) || 24, 24 * 14);
    const desde = new Date(Date.now() - horas * 60 * 60 * 1000);
    const snapshots = await prisma.memorySnapshot.findMany({
      where: { createdAt: { gte: desde } },
      orderBy: { createdAt: "asc" },
    });
    res.json({ snapshots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/monitoreo/latencia?horas=24
router.get("/latencia", async (req, res) => {
  try {
    const horas = Math.min(Number(req.query.horas) || 24, 24 * 14);
    const desde = new Date(Date.now() - horas * 60 * 60 * 1000);
    const metrics = await prisma.requestMetric.findMany({
      where: { windowStart: { gte: desde } },
      orderBy: { windowStart: "asc" },
    });
    res.json({ metrics });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
