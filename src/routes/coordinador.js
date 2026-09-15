const express = require("express");
const ExcelJS = require("exceljs");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");
const coordinadorMiddleware = require("../middleware/coordinador");

const router = express.Router();
const prisma = new PrismaClient();

router.use(authMiddleware, coordinadorMiddleware);

const STATUS_GROUPS = {
  PENDIENTE: ["NUEVO", "SEGUIMIENTO", "NEGOCIACION"],
  CONCRETADA: ["VENTA"],
  RECHAZADA: ["ARCHIVADO"],
  REAGENDADA: ["REAGENDADO"],
};

function classify(status) {
  if (STATUS_GROUPS.CONCRETADA.includes(status)) return "concretada";
  if (STATUS_GROUPS.RECHAZADA.includes(status)) return "rechazada";
  if (STATUS_GROUPS.REAGENDADA.includes(status)) return "reagendada";
  return "pendiente";
}

// GET /api/coordinador/overview
router.get("/overview", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const inicioDia = new Date();
    inicioDia.setHours(0, 0, 0, 0);

    const [vendedores, grouped, ventasHoy] = await Promise.all([
      prisma.user.findMany({ where: { rol: "VENDEDOR", tenantId }, select: { id: true, nombre: true } }),
      prisma.lead.groupBy({ by: ["vendedorId", "status"], where: { tenantId }, _count: true }),
      prisma.venta.groupBy({
        by: ["vendedorId"],
        where: { tenantId, fecha: { gte: inicioDia } },
        _sum: { monto: true, comision: true },
      }),
    ]);

    const porVendedor = {};
    for (const v of vendedores) {
      porVendedor[v.id] = {
        id: v.id, nombre: v.nombre,
        asignados: 0, pendientes: 0, concretadas: 0, rechazadas: 0, reagendadas: 0,
        ventasHoy: 0, comisionHoy: 0,
      };
    }

    for (const row of ventasHoy) {
      const bucket = porVendedor[row.vendedorId];
      if (bucket) {
        bucket.ventasHoy = row._sum.monto || 0;
        bucket.comisionHoy = row._sum.comision || 0;
      }
    }

    const totales = { asignados: 0, pendientes: 0, concretadas: 0, rechazadas: 0, reagendadas: 0 };

    for (const row of grouped) {
      const bucket = porVendedor[row.vendedorId];
      const key = classify(row.status);
      const field = key === "pendiente" ? "pendientes" : key === "concretada" ? "concretadas" : key === "rechazada" ? "rechazadas" : "reagendadas";
      totales.asignados += row._count;
      totales[field] += row._count;
      if (bucket) {
        bucket.asignados += row._count;
        bucket[field] += row._count;
      }
    }

    const vendedoresConEficiencia = Object.values(porVendedor)
      .map((v) => ({ ...v, eficiencia: v.asignados > 0 ? Math.round((v.concretadas / v.asignados) * 100) : 0 }))
      .sort((a, b) => b.eficiencia - a.eficiencia);

    res.json({ totales, vendedores: vendedoresConEficiencia });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/coordinador/vendedores
router.get("/vendedores", async (req, res) => {
  try {
    const vendedores = await prisma.user.findMany({
      where: { rol: "VENDEDOR", activo: true, tenantId: req.user.tenantId },
      select: { id: true, nombre: true },
      orderBy: { nombre: "asc" },
    });
    res.json({ vendedores });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/coordinador/leads
router.get("/leads", async (req, res) => {
  try {
    const { state, productoId, search } = req.query;
    const where = { tenantId: req.user.tenantId, asignadoPorCoordinador: false };
    if (state) where.state = state;
    if (productoId) where.productoId = parseInt(productoId);
    if (search) {
      where.OR = [
        { nombre: { contains: search, mode: "insensitive" } },
        { producto: { contains: search, mode: "insensitive" } },
      ];
    }

    const leads = await prisma.lead.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { vendedor: { select: { id: true, nombre: true } } },
    });

    res.json({ leads });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/coordinador/leads/asignar
router.post("/leads/asignar", async (req, res) => {
  try {
    const { leadIds, vendedorId } = req.body;
    if (!Array.isArray(leadIds) || leadIds.length === 0 || !vendedorId) {
      return res.status(400).json({ error: "leadIds y vendedorId requeridos" });
    }

    const vendedor = await prisma.user.findFirst({
      where: { id: parseInt(vendedorId), rol: "VENDEDOR", activo: true, tenantId: req.user.tenantId },
    });
    if (!vendedor) return res.status(404).json({ error: "Vendedor no encontrado" });

    const result = await prisma.lead.updateMany({
      where: { id: { in: leadIds.map(Number) }, tenantId: req.user.tenantId },
      data: { vendedorId: vendedor.id, asignadoPorCoordinador: true },
    });

    res.json({ message: "Leads asignados", actualizados: result.count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/coordinador/progreso?fecha=YYYY-MM-DD
router.get("/progreso", async (req, res) => {
  try {
    const fecha = req.query.fecha ? new Date(`${req.query.fecha}T00:00:00`) : new Date();
    const inicio = new Date(fecha); inicio.setHours(0, 0, 0, 0);
    const fin = new Date(inicio); fin.setDate(fin.getDate() + 1);

    const leads = await prisma.lead.findMany({
      where: { tenantId: req.user.tenantId, createdAt: { gte: inicio, lt: fin } },
      orderBy: { createdAt: "desc" },
      include: {
        vendedor: { select: { id: true, nombre: true } },
        items: { include: { producto: { select: { nombre: true } } } },
      },
    });

    res.json({ fecha: inicio, total: leads.length, leads });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

function buildHistorialWhere(req) {
  const { from, to, vendedorId, estado, search } = req.query;
  const where = { tenantId: req.user.tenantId };

  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(`${from}T00:00:00`);
    if (to) where.createdAt.lte = new Date(`${to}T23:59:59`);
  }
  if (vendedorId) where.vendedorId = parseInt(vendedorId);
  if (estado && estado !== "TODOS" && STATUS_GROUPS[estado]) {
    where.status = { in: STATUS_GROUPS[estado] };
  }
  if (search) {
    where.OR = [
      { nombre: { contains: search, mode: "insensitive" } },
      { producto: { contains: search, mode: "insensitive" } },
      { telefono: { contains: search, mode: "insensitive" } },
    ];
  }
  return where;
}

// GET /api/coordinador/historial
router.get("/historial", async (req, res) => {
  try {
    const where = buildHistorialWhere(req);
    const take = Math.min(parseInt(req.query.take) || 50, 200);
    const skip = parseInt(req.query.skip) || 0;

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: { vendedor: { select: { id: true, nombre: true } } },
      }),
      prisma.lead.count({ where }),
    ]);

    res.json({ leads, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/coordinador/historial/export
router.get("/historial/export", async (req, res) => {
  try {
    const where = buildHistorialWhere(req);
    const leads = await prisma.lead.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 5000,
      include: { vendedor: { select: { nombre: true } } },
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Historial");
    sheet.columns = [
      { header: "Vendedor", key: "vendedor", width: 22 },
      { header: "Cliente", key: "cliente", width: 24 },
      { header: "Telefono", key: "telefono", width: 16 },
      { header: "Producto", key: "producto", width: 22 },
      { header: "Estado", key: "estado", width: 16 },
      { header: "Estatus", key: "estatus", width: 14 },
      { header: "Fecha", key: "fecha", width: 18 },
      { header: "Monto", key: "monto", width: 12 },
    ];
    for (const lead of leads) {
      sheet.addRow({
        vendedor: lead.vendedor?.nombre || "",
        cliente: lead.nombre,
        telefono: lead.telefono,
        producto: lead.producto,
        estado: lead.state || "",
        estatus: classify(lead.status),
        fecha: lead.createdAt,
        monto: lead.monto || "",
      });
    }
    sheet.getRow(1).font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="historial.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
