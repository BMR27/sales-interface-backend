const express = require("express");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// GET /api/geocode?q=<direccion en texto libre>
router.get("/", authMiddleware, async (req, res) => {
  try {
    const query = (req.query.q || "").trim();
    if (!query) return res.status(400).json({ error: "q es requerido" });

    const cached = await prisma.geocodeCache.findUnique({ where: { query } });
    if (cached) {
      return res.json({ lat: cached.lat, lng: cached.lng });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch(
      `${NOMINATIM_URL}?q=${encodeURIComponent(query)}&countrycodes=mx&format=json&limit=1`,
      {
        signal: controller.signal,
        headers: { "User-Agent": "VentasCPA-SalesInterface/1.0 (contacto@ventascpa.mx)" },
      }
    );
    clearTimeout(timeout);

    if (!resp.ok) return res.json({ lat: null, lng: null });

    const results = await resp.json();
    if (!results || results.length === 0) return res.json({ lat: null, lng: null });

    const lat = parseFloat(results[0].lat);
    const lng = parseFloat(results[0].lon);

    await prisma.geocodeCache.upsert({
      where: { query },
      update: {},
      create: { query, lat, lng },
    });

    res.json({ lat, lng });
  } catch (err) {
    console.error("Error en geocode:", err.message);
    res.json({ lat: null, lng: null });
  }
});

module.exports = router;
