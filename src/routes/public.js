const express = require("express");
const { PrismaClient } = require("@prisma/client");

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/public/branding?host=empresaA.midominio.com
// Sin autenticacion: la pantalla de login necesita saber de que empresa es
// antes de que exista cualquier sesion. Si el host no coincide con ningun
// dominio/subdominio configurado, responde { tenant: null } y el frontend
// usa el branding por defecto de la plataforma (comportamiento actual).
router.get("/branding", async (req, res) => {
  try {
    const host = String(req.query.host || "").toLowerCase().trim();
    if (!host) return res.json({ tenant: null });

    let tenant = await prisma.tenant.findFirst({
      where: { dominioPersonalizado: host, status: "ACTIVO" },
    });

    if (!tenant) {
      const rootDomain = String(process.env.ROOT_DOMAIN || "").toLowerCase().trim();
      if (rootDomain && host.endsWith(`.${rootDomain}`)) {
        const sub = host.slice(0, -(rootDomain.length + 1));
        if (sub && !sub.includes(".")) {
          tenant = await prisma.tenant.findFirst({
            where: { subdominio: sub, status: "ACTIVO" },
          });
        }
      }
    }

    if (!tenant) return res.json({ tenant: null });

    res.json({
      tenant: {
        nombre: tenant.nombreComercial || tenant.razonSocial,
        logoUrl: tenant.logoUrl,
        colorPrimario: tenant.colorPrimario,
        colorSecundario: tenant.colorSecundario,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
