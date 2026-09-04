const express = require("express");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");
const superAdminMiddleware = require("../middleware/superAdmin");

const router = express.Router();
const prisma = new PrismaClient();

router.use(authMiddleware, superAdminMiddleware);

const VALID_STATUS = ["PENDIENTE", "ACTIVO", "RECHAZADO", "SUSPENDIDO"];

// GET /api/superadmin/tenants?status=PENDIENTE
router.get("/tenants", async (req, res) => {
  try {
    const { status } = req.query;
    const where = status ? { status } : {};
    if (status && !VALID_STATUS.includes(status)) {
      return res.status(400).json({ error: "status inválido" });
    }

    const tenants = await prisma.tenant.findMany({
      where,
      include: {
        users: { where: { rol: "ADMIN" }, select: { id: true, nombre: true, email: true } },
        _count: { select: { users: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(tenants);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/superadmin/tenants/:id
router.get("/tenants/:id", async (req, res) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        users: { select: { id: true, nombre: true, email: true, rol: true, activo: true } },
        aprobadoPor: { select: { id: true, nombre: true, email: true } },
      },
    });
    if (!tenant) return res.status(404).json({ error: "Espacio no encontrado" });
    res.json(tenant);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/superadmin/tenants/:id/aprobar
router.post("/tenants/:id/aprobar", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) return res.status(404).json({ error: "Espacio no encontrado" });

    const actualizado = await prisma.tenant.update({
      where: { id },
      data: {
        status: "ACTIVO",
        aprobadoPorId: req.user.id,
        approvedAt: new Date(),
        motivoRechazo: null,
      },
    });

    res.json(actualizado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/superadmin/tenants/:id/rechazar
router.post("/tenants/:id/rechazar", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { motivo } = req.body;
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) return res.status(404).json({ error: "Espacio no encontrado" });

    const actualizado = await prisma.tenant.update({
      where: { id },
      data: { status: "RECHAZADO", motivoRechazo: motivo || null },
    });

    res.json(actualizado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// PUT /api/superadmin/tenants/:id/suspender
router.put("/tenants/:id/suspender", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) return res.status(404).json({ error: "Espacio no encontrado" });

    const actualizado = await prisma.tenant.update({
      where: { id },
      data: { status: "SUSPENDIDO" },
    });

    res.json(actualizado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/superadmin/tenants/:id/impersonate
router.post("/tenants/:id/impersonate", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) return res.status(404).json({ error: "Espacio no encontrado" });
    if (tenant.status !== "ACTIVO") {
      return res.status(400).json({ error: "Solo se puede ver espacios activos" });
    }

    const nombre = `${tenant.nombreComercial || tenant.razonSocial} (vista superadmin)`;

    const token = jwt.sign(
      {
        id: null,
        email: tenant.emailContacto,
        rol: "ADMIN",
        nombre,
        tenantId: tenant.id,
        tenantStatus: tenant.status,
        impersonatedBy: req.user.id,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({
      token,
      user: { id: null, nombre, email: tenant.emailContacto, rol: "ADMIN", tenantId: tenant.id },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
