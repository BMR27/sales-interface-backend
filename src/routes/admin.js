const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");
const { getNextVendedor } = require("../lib/assignment");
const { parseWorkbookBuffer, validateRow, buildTemplateBuffer } = require("../lib/leadsImport");

const router = express.Router();
const prisma = new PrismaClient();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /\.xlsx$/i.test(file.originalname || ""));
  },
});

router.use(authMiddleware, adminMiddleware);

// GET /api/admin/overview
router.get("/overview", async (req, res) => {
  try {
    const ahora = new Date();
    const inicioDia = new Date(ahora); inicioDia.setHours(0, 0, 0, 0);
    const inicioSemana = new Date(ahora); inicioSemana.setDate(ahora.getDate() - ahora.getDay()); inicioSemana.setHours(0, 0, 0, 0);
    const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);

    const tenantId = req.user.tenantId;

    const [ventasHoy, ventasSemana, ventasMes, leadsPorStatus, leadsHoyApi, topVendedores, recentLeads, recentVentas] = await Promise.all([
      prisma.venta.aggregate({ where: { tenantId, fecha: { gte: inicioDia } }, _sum: { monto: true, comision: true }, _count: true }),
      prisma.venta.aggregate({ where: { tenantId, fecha: { gte: inicioSemana } }, _sum: { monto: true, comision: true }, _count: true }),
      prisma.venta.aggregate({ where: { tenantId, fecha: { gte: inicioMes } }, _sum: { monto: true, comision: true }, _count: true }),
      prisma.lead.groupBy({ by: ["status"], where: { tenantId }, _count: true }),
      prisma.lead.count({ where: { tenantId, source: "EXTERNAL_API", createdAt: { gte: inicioDia } } }),
      prisma.user.findMany({
        where: { rol: "VENDEDOR", tenantId },
        select: {
          id: true, nombre: true,
          _count: { select: { ventas: true } },
          ventas: { select: { monto: true } },
        },
      }),
      prisma.lead.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 10, include: { vendedor: { select: { id: true, nombre: true } } } }),
      prisma.venta.findMany({
        where: { tenantId },
        orderBy: { fecha: "desc" }, take: 10,
        include: { lead: { select: { producto: true, nombre: true } }, vendedor: { select: { id: true, nombre: true } } },
      }),
    ]);

    const top = topVendedores
      .map((v) => ({ id: v.id, nombre: v.nombre, ventas: v._count.ventas, monto: v.ventas.reduce((s, x) => s + x.monto, 0) }))
      .sort((a, b) => b.monto - a.monto)
      .slice(0, 5);

    res.json({
      ventas: {
        hoy: { monto: ventasHoy._sum.monto || 0, comision: ventasHoy._sum.comision || 0, count: ventasHoy._count },
        semana: { monto: ventasSemana._sum.monto || 0, comision: ventasSemana._sum.comision || 0, count: ventasSemana._count },
        mes: { monto: ventasMes._sum.monto || 0, comision: ventasMes._sum.comision || 0, count: ventasMes._count },
      },
      leadsPorStatus: leadsPorStatus.reduce((acc, c) => ({ ...acc, [c.status]: c._count }), {}),
      leadsHoyApi,
      topVendedores: top,
      recentLeads,
      recentVentas,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/leads/bulk-template — plantilla de Excel para carga masiva
router.get("/leads/bulk-template", async (req, res) => {
  try {
    const buffer = await buildTemplateBuffer();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", 'attachment; filename="plantilla_leads.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/admin/leads/bulk — carga masiva de leads, vía archivo Excel (multipart) o JSON { leads: [...] }
router.post("/leads/bulk", upload.single("file"), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    let rows;

    if (req.file) {
      let parsed;
      try {
        parsed = await parseWorkbookBuffer(req.file.buffer);
      } catch (parseErr) {
        return res.status(400).json({ error: "El archivo no es un Excel (.xlsx) válido" });
      }
      rows = parsed.map((r) => ({ ref: `fila ${r.rowNumber}`, data: r.data }));
    } else if (Array.isArray(req.body?.leads)) {
      rows = req.body.leads.map((data, i) => ({ ref: `elemento ${i + 1}`, data }));
    } else {
      return res.status(400).json({ error: "Envía un archivo Excel (campo 'file') o un JSON con { leads: [...] }" });
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: "No se encontraron filas con datos" });
    }
    if (rows.length > 1000) {
      return res.status(400).json({ error: "Máximo 1000 leads por carga" });
    }

    const vendedoresCache = new Map();
    async function resolveVendedor(email) {
      if (!email) return getNextVendedor(prisma, tenantId);
      const key = String(email).toLowerCase();
      if (vendedoresCache.has(key)) return vendedoresCache.get(key);
      const vendedor = await prisma.user.findFirst({
        where: { email: key, tenantId, rol: "VENDEDOR", activo: true },
      });
      vendedoresCache.set(key, vendedor);
      return vendedor;
    }

    const resultados = { creados: 0, errores: [] };

    for (const { ref, data } of rows) {
      const error = validateRow(data);
      if (error) {
        resultados.errores.push({ fila: ref, error });
        continue;
      }

      const vendedor = await resolveVendedor(data.vendedorEmail);
      if (!vendedor) {
        resultados.errores.push({
          fila: ref,
          error: data.vendedorEmail
            ? `Vendedor '${data.vendedorEmail}' no encontrado o inactivo`
            : "No hay vendedores activos disponibles",
        });
        continue;
      }

      let productoId = null;
      if (data.internalSku) {
        const producto = await prisma.producto.findFirst({
          where: { sku: String(data.internalSku), tenantId },
        });
        productoId = producto?.id ?? null;
      }

      try {
        const edadNum = Number(data.edad);
        await prisma.lead.create({
          data: {
            nombre: String(data.nombre),
            apellido: data.apellido ? String(data.apellido) : null,
            edad: data.edad !== undefined && data.edad !== "" && Number.isFinite(edadNum) ? edadNum : null,
            telefono: String(data.telefono),
            producto: String(data.producto),
            cantidad: data.cantidad ? Number(data.cantidad) || 1 : 1,
            categoria: data.categoria ? String(data.categoria) : null,
            notas: data.notas ? String(data.notas) : null,
            country: data.country ? String(data.country) : null,
            city: data.city ? String(data.city) : null,
            ip: data.ip ? String(data.ip) : null,
            state: data.state ? String(data.state) : null,
            zipCode: data.zipCode ? String(data.zipCode) : null,
            internalSku: data.internalSku ? String(data.internalSku) : null,
            productoId,
            vendedorId: vendedor.id,
            source: "MANUAL",
            tenantId,
          },
        });
        resultados.creados += 1;
      } catch (err) {
        resultados.errores.push({ fila: ref, error: "No se pudo crear el lead" });
      }
    }

    res.status(201).json(resultados);
  } catch (err) {
    console.error(err);
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/leads
router.get("/leads", async (req, res) => {
  try {
    const { status, vendedorId, search, source } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (status) where.status = status.toUpperCase();
    if (vendedorId) where.vendedorId = parseInt(vendedorId);
    if (source) where.source = source.toUpperCase();
    if (search) {
      where.OR = [
        { nombre: { contains: search, mode: "insensitive" } },
        { producto: { contains: search, mode: "insensitive" } },
        { folio: { contains: search, mode: "insensitive" } },
      ];
    }

    const leads = await prisma.lead.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      include: { vendedor: { select: { id: true, nombre: true, email: true } } },
    });

    res.json({ leads });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// PUT /api/admin/leads/:id/reassign
router.put("/leads/:id/reassign", async (req, res) => {
  try {
    const { vendedorId } = req.body;
    if (!vendedorId) return res.status(400).json({ error: "vendedorId requerido" });
    const tenantId = req.user.tenantId;

    const vendedor = await prisma.user.findFirst({ where: { id: vendedorId, rol: "VENDEDOR", activo: true, tenantId } });
    if (!vendedor) return res.status(404).json({ error: "Vendedor no encontrado o inactivo" });

    const existing = await prisma.lead.findFirst({ where: { id: parseInt(req.params.id), tenantId } });
    if (!existing) return res.status(404).json({ error: "Lead no encontrado" });

    const lead = await prisma.lead.update({
      where: { id: existing.id },
      data: { vendedorId },
      include: { vendedor: { select: { id: true, nombre: true } } },
    });

    res.json(lead);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/ventas
router.get("/ventas", async (req, res) => {
  try {
    const { vendedorId, desde, hasta } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (vendedorId) where.vendedorId = parseInt(vendedorId);
    if (desde || hasta) {
      where.fecha = {};
      if (desde) where.fecha.gte = new Date(desde);
      if (hasta) where.fecha.lte = new Date(hasta);
    }

    const ventas = await prisma.venta.findMany({
      where,
      orderBy: { fecha: "desc" },
      include: {
        lead: { select: { nombre: true, producto: true, folio: true } },
        vendedor: { select: { id: true, nombre: true } },
      },
    });

    const total = ventas.reduce((s, v) => s + v.monto, 0);

    res.json({ ventas, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/vendedores
router.get("/vendedores", async (req, res) => {
  try {
    const usuarios = await prisma.user.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, nombre: true, email: true, rol: true, activo: true, createdAt: true,
        _count: { select: { leads: true, ventas: true } },
        ventas: { select: { monto: true } },
        apiKeysCreadas: {
          select: {
            incomingLeads: {
              select: {
                assignedLead: { select: { status: true, venta: { select: { monto: true } } } },
              },
            },
          },
        },
      },
    });

    const vendedores = usuarios.map((u) => {
      if (u.rol === "PROVEEDOR_LEADS") {
        const incoming = u.apiKeysCreadas.flatMap((k) => k.incomingLeads);
        const ventas = incoming.filter((i) => i.assignedLead?.status === "VENTA");
        return {
          id: u.id, nombre: u.nombre, email: u.email, rol: u.rol, activo: u.activo, createdAt: u.createdAt,
          leadsCount: incoming.length,
          ventasCount: ventas.length,
          montoTotal: ventas.reduce((s, v) => s + (v.assignedLead?.venta?.monto || 0), 0),
        };
      }
      return {
        id: u.id,
        nombre: u.nombre,
        email: u.email,
        rol: u.rol,
        activo: u.activo,
        createdAt: u.createdAt,
        leadsCount: u._count.leads,
        ventasCount: u._count.ventas,
        montoTotal: u.ventas.reduce((s, v) => s + v.monto, 0),
      };
    });

    res.json({ vendedores });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/admin/vendedores
router.post("/vendedores", async (req, res) => {
  try {
    const { nombre, email, password, rol } = req.body;
    if (!nombre || !email || !password) {
      return res.status(400).json({ error: "Nombre, email y contraseña requeridos" });
    }
    const rolFinal = rol || "VENDEDOR";
    if (!["ADMIN", "VENDEDOR"].includes(rolFinal)) {
      return res.status(400).json({ error: "rol inválido" });
    }

    const existe = await prisma.user.findUnique({ where: { email } });
    if (existe) return res.status(409).json({ error: "El email ya está registrado" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { nombre, email, password: hashedPassword, rol: rolFinal, tenantId: req.user.tenantId },
    });

    res.status(201).json({ id: user.id, nombre: user.nombre, email: user.email, rol: user.rol, activo: user.activo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// PUT /api/admin/vendedores/:id
router.put("/vendedores/:id", async (req, res) => {
  try {
    const { nombre, email, rol, activo } = req.body;
    if (rol !== undefined && !["ADMIN", "VENDEDOR"].includes(rol)) {
      return res.status(400).json({ error: "rol inválido" });
    }

    const existing = await prisma.user.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Usuario no encontrado" });

    const data = {};
    if (nombre !== undefined) data.nombre = nombre;
    if (email !== undefined) data.email = email;
    if (rol !== undefined) data.rol = rol;
    if (activo !== undefined) data.activo = activo;

    const user = await prisma.user.update({
      where: { id: existing.id },
      data,
      select: { id: true, nombre: true, email: true, rol: true, activo: true },
    });

    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/admin/proveedores/invitacion — genera un link de registro para un proveedor de leads de este espacio
router.post("/proveedores/invitacion", async (req, res) => {
  try {
    const token = jwt.sign(
      { tenantId: req.user.tenantId, purpose: "proveedor_invite" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    const base = process.env.FRONTEND_URL || "";
    const link = `${base}/registro-proveedor?token=${token}`;
    res.status(201).json({ token, link, expiresIn: "7 días" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
