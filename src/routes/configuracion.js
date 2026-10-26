const express = require("express");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");
const { getPermisosEfectivos } = require("../lib/permisosCatalog");
const { getParametros } = require("../lib/parametros");

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/configuracion/mis-permisos — permisos efectivos del usuario autenticado,
// usados por el frontend para ocultar modulos/acciones desactivados por su ADMIN.
router.get("/mis-permisos", authMiddleware, async (req, res) => {
  try {
    const permisos = await getPermisosEfectivos(req.user.tenantId, req.user.rol);
    res.json({ rol: req.user.rol, permisos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/configuracion/parametros — solo lectura, para cualquier usuario
// autenticado: el panel de llamada necesita el costo de envío y la comisión
// vigentes, pero sólo el ADMIN puede cambiarlos.
router.get("/parametros", authMiddleware, async (req, res) => {
  try {
    res.json({ valores: await getParametros(req.user.tenantId) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/configuracion
router.get("/", authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, nombre: true, email: true, rol: true, activo: true, createdAt: true,
        tenant: { select: { nombreComercial: true, razonSocial: true } },
      },
    });
    res.json({
      ...user,
      empresa: user.tenant ? (user.tenant.nombreComercial || user.tenant.razonSocial) : null,
      tenant: undefined,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// PUT /api/configuracion
router.put("/", authMiddleware, async (req, res) => {
  try {
    const { nombre, email, passwordActual, passwordNuevo } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    const data = {};
    if (nombre) data.nombre = nombre;
    if (email && email !== user.email) {
      const existe = await prisma.user.findUnique({ where: { email } });
      if (existe) return res.status(409).json({ error: "Email ya en uso" });
      data.email = email;
    }

    if (passwordNuevo) {
      if (!passwordActual) return res.status(400).json({ error: "Contraseña actual requerida" });
      const ok = await bcrypt.compare(passwordActual, user.password);
      if (!ok) return res.status(401).json({ error: "Contraseña actual incorrecta" });
      data.password = await bcrypt.hash(passwordNuevo, 10);
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: { id: true, nombre: true, email: true, rol: true },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
