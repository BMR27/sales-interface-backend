const express = require("express");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

const SEPOMEX_URL = "https://sepomex.kurenn.dev/api/v1/zip_codes";

// GET /api/codigos-postales?cp=XXXXX
router.get("/", authMiddleware, async (req, res) => {
  try {
    const cp = (req.query.cp || "").trim();
    if (!/^\d{5}$/.test(cp)) {
      return res.status(400).json({ error: "Código postal inválido, debe tener 5 dígitos" });
    }

    let cached = await prisma.codigoPostal.findMany({ where: { cp } });

    if (cached.length === 0) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const resp = await fetch(`${SEPOMEX_URL}?zip_code=${cp}`, { signal: controller.signal });
        clearTimeout(timeout);

        if (resp.ok) {
          const data = await resp.json();
          const rows = data.zip_codes || [];

          for (const row of rows) {
            await prisma.codigoPostal.upsert({
              where: { cp_colonia: { cp, colonia: row.d_asenta } },
              update: {},
              create: {
                cp,
                colonia: row.d_asenta,
                tipoAsentamiento: row.d_tipo_asenta,
                municipio: row.d_mnpio,
                estado: row.d_estado,
                ciudad: row.d_ciudad,
              },
            });
          }

          cached = await prisma.codigoPostal.findMany({ where: { cp } });
        }
      } catch (fetchErr) {
        console.error("Error consultando SEPOMEX:", fetchErr.message);
      }
    }

    res.json({
      colonias: cached.map((c) => ({
        colonia: c.colonia,
        tipoAsentamiento: c.tipoAsentamiento,
        municipio: c.municipio,
        estado: c.estado,
        ciudad: c.ciudad,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
