const express = require("express");
const jwt = require("jsonwebtoken");
const authMiddleware = require("../middleware/auth");
const superAdminMiddleware = require("../middleware/superAdmin");

const router = express.Router();
const prisma = require("../lib/prisma");

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
        aprobadoPor: { select: { id: true, nombre: true, email: true } },
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

// PUT /api/superadmin/tenants/:id/facturacion
router.put("/tenants/:id/facturacion", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { plan, montoMensual, proximoCobro, estadoCobro } = req.body;

    if (estadoCobro !== undefined && !["AL_CORRIENTE", "VENCIDO"].includes(estadoCobro)) {
      return res.status(400).json({ error: "estadoCobro inválido" });
    }

    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) return res.status(404).json({ error: "Espacio no encontrado" });

    const data = {};
    if (plan !== undefined) data.plan = plan || null;
    if (montoMensual !== undefined) data.montoMensual = montoMensual === null || montoMensual === "" ? null : Number(montoMensual);
    if (proximoCobro !== undefined) data.proximoCobro = proximoCobro ? new Date(proximoCobro) : null;
    if (estadoCobro !== undefined) data.estadoCobro = estadoCobro;

    const actualizado = await prisma.tenant.update({ where: { id }, data });
    res.json(actualizado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// A donde entra el "Ver como" segun el rol prestado. Es el mismo mapa que
// usa el front en lib/guard.ts; se manda desde aqui para que el superadmin
// no tenga que adivinar a que pantalla ir.
const INICIO_POR_ROL = {
  ADMIN: "/admin",
  ADMIN_OPERATIVO: "/admin",
  COORDINADOR: "/coordinador",
  PROVEEDOR_LEADS: "/proveedor",
  VENDEDOR: "/leads",
};

// Roles que se pueden prestar. SUPER_ADMIN queda fuera a proposito: no hay
// nada que ver que el superadmin no vea ya, y encadenar impersonaciones
// hace imposible auditar quien hizo que.
const ROLES_IMPERSONABLES = Object.keys(INICIO_POR_ROL);

// GET /api/superadmin/tenants/:id/usuarios
//
// A quien se puede "ver como" dentro de un espacio. La pantalla necesita a
// la persona concreta, no solo el rol: la vista de una vendedora son sus
// leads, y sin un usuario real no hay nada que mostrar.
router.get("/tenants/:id/usuarios", async (req, res) => {
  try {
    const tenantId = Number(req.params.id);
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return res.status(404).json({ error: "Espacio no encontrado" });

    const usuarios = await prisma.user.findMany({
      where: { tenantId, activo: true, rol: { in: ROLES_IMPERSONABLES } },
      select: { id: true, nombre: true, email: true, rol: true },
      orderBy: [{ rol: "asc" }, { nombre: "asc" }],
    });

    res.json(usuarios);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/superadmin/tenants/:id/impersonate   body: { userId? }
//
// Sin userId se entra como administrador generico del espacio (la vista de
// siempre). Con userId se toma prestada la vista de esa persona -- su rol,
// sus leads, su menu -- que es la unica forma de ver lo que ella ve cuando
// reporta un problema.
router.post("/tenants/:id/impersonate", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) return res.status(404).json({ error: "Espacio no encontrado" });
    if (tenant.status !== "ACTIVO") {
      return res.status(400).json({ error: "Solo se puede ver espacios activos" });
    }

    const { userId } = req.body || {};
    let destinatario = null;

    if (userId) {
      destinatario = await prisma.user.findFirst({
        where: { id: Number(userId), tenantId: tenant.id, activo: true },
        select: { id: true, nombre: true, email: true, rol: true },
      });
      if (!destinatario) {
        return res.status(404).json({ error: "Usuario no encontrado en este espacio" });
      }
      if (!ROLES_IMPERSONABLES.includes(destinatario.rol)) {
        return res.status(400).json({ error: "No se puede ver como ese rol" });
      }
    }

    const etiqueta = tenant.nombreComercial || tenant.razonSocial;
    const nombre = destinatario
      ? `${destinatario.nombre} (vista superadmin)`
      : `${etiqueta} (vista superadmin)`;
    const rol = destinatario ? destinatario.rol : "ADMIN";
    const email = destinatario ? destinatario.email : tenant.emailContacto;
    // El id real importa: la cola de una vendedora se arma con
    // `vendedorId: req.user.id`, asi que sin el no habria nada que ver.
    // Las escrituras quedan a su nombre, por eso el token lleva
    // `impersonatedBy` y la pantalla avisa con una banda fija.
    const userIdFinal = destinatario ? destinatario.id : null;

    const token = jwt.sign(
      {
        id: userIdFinal,
        email,
        rol,
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
      user: { id: userIdFinal, nombre, email, rol, tenantId: tenant.id },
      destino: INICIO_POR_ROL[rol] || "/admin",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
