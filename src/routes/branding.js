const express = require("express");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");

const router = express.Router();
const prisma = new PrismaClient();

router.use(authMiddleware, adminMiddleware);

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const SELECT_FIELDS = {
  nombreComercial: true,
  razonSocial: true,
  subdominio: true,
  dominioPersonalizado: true,
  logoUrl: true,
  colorPrimario: true,
  colorSecundario: true,
};

// GET /api/admin/branding
router.get("/", async (req, res) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: SELECT_FIELDS,
    });
    if (!tenant) return res.status(404).json({ error: "Espacio no encontrado" });
    res.json(tenant);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// La marca del espacio (logo, colores, dominio) solo la administra Bryan --
// el resto de los ADMIN del tenant pueden ver la configuracion pero no editarla.
const EMAIL_ADMIN_MARCA = "bryan.mejia@perfectself.com.mx";

// PUT /api/admin/branding
router.put("/", async (req, res) => {
  try {
    if (req.user.email !== EMAIL_ADMIN_MARCA) {
      return res.status(403).json({ error: "Solo Bryan Mejia puede modificar la marca del espacio" });
    }
    const { nombreComercial, subdominio, dominioPersonalizado, logoUrl, colorPrimario, colorSecundario } = req.body;
    const data = {};

    if (nombreComercial !== undefined) data.nombreComercial = nombreComercial || null;
    if (logoUrl !== undefined) data.logoUrl = logoUrl || null;
    if (colorPrimario !== undefined) data.colorPrimario = colorPrimario || null;
    if (colorSecundario !== undefined) data.colorSecundario = colorSecundario || null;

    if (subdominio !== undefined) {
      if (!subdominio) {
        data.subdominio = null;
      } else {
        const normalizado = String(subdominio).toLowerCase().trim();
        if (!SUBDOMAIN_RE.test(normalizado)) {
          return res.status(400).json({ error: "Subdominio invalido. Usa solo letras minusculas, numeros y guiones." });
        }
        data.subdominio = normalizado;
      }
    }

    if (dominioPersonalizado !== undefined) {
      data.dominioPersonalizado = dominioPersonalizado ? String(dominioPersonalizado).toLowerCase().trim() : null;
    }

    const actualizado = await prisma.tenant.update({
      where: { id: req.user.tenantId },
      data,
      select: SELECT_FIELDS,
    });

    res.json(actualizado);
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Ese subdominio o dominio ya esta en uso por otra empresa" });
    }
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
