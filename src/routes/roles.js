const express = require("express");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");
const { PERMISOS_CATALOG, ROLES_CONFIGURABLES, clavesValidas, getPermisosEfectivos } = require("../lib/permisosCatalog");

const router = express.Router();
const prisma = new PrismaClient();

router.use(authMiddleware, adminMiddleware);

// GET /api/admin/roles — catalogo completo + permisos efectivos del tenant actual
router.get("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const permisos = {};
    for (const rol of ROLES_CONFIGURABLES) {
      permisos[rol] = await getPermisosEfectivos(tenantId, rol);
    }
    res.json({ catalogo: PERMISOS_CATALOG, permisos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// PUT /api/admin/roles — guarda cambios { cambios: [{ rol, clave, activo }] }
router.put("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const cambios = Array.isArray(req.body.cambios) ? req.body.cambios : [];

    for (const cambio of cambios) {
      if (!ROLES_CONFIGURABLES.includes(cambio.rol) || !clavesValidas(cambio.rol).has(cambio.clave)) {
        return res.status(400).json({ error: `Permiso invalido: ${cambio.rol}.${cambio.clave}` });
      }
    }

    await prisma.$transaction(
      cambios.map((cambio) =>
        prisma.rolePermiso.upsert({
          where: { tenantId_rol_clave: { tenantId, rol: cambio.rol, clave: cambio.clave } },
          update: { activo: !!cambio.activo },
          create: { tenantId, rol: cambio.rol, clave: cambio.clave, activo: !!cambio.activo },
        })
      )
    );

    const permisos = {};
    for (const rol of ROLES_CONFIGURABLES) {
      permisos[rol] = await getPermisosEfectivos(tenantId, rol);
    }
    res.json({ catalogo: PERMISOS_CATALOG, permisos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
