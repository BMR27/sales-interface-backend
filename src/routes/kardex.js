const express = require("express");
const ExcelJS = require("exceljs");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");
const { ETIQUETAS } = require("../lib/auditoria");

const router = express.Router();
const prisma = require("../lib/prisma");

// Kardex es sólo para administradores: muestra quién hizo qué en todo el
// espacio, incluidos los datos de contacto de cada usuario.
router.use(authMiddleware, adminMiddleware);

function buildWhere(req) {
  const { accion, entidad, usuario, origen, search, desde, hasta } = req.query;
  const where = { tenantId: req.user.tenantId };

  if (accion) where.accion = accion;
  if (entidad) where.entidad = entidad;
  if (origen) where.origen = origen;
  if (usuario) where.userId = parseInt(usuario);

  if (desde || hasta) {
    where.createdAt = {};
    if (desde) where.createdAt.gte = new Date(`${desde}T00:00:00`);
    if (hasta) where.createdAt.lte = new Date(`${hasta}T23:59:59`);
  }

  if (search) {
    where.OR = [
      { descripcion: { contains: search, mode: "insensitive" } },
      { userNombre: { contains: search, mode: "insensitive" } },
      { userEmail: { contains: search, mode: "insensitive" } },
      { entidadId: { contains: search, mode: "insensitive" } },
      { ruta: { contains: search, mode: "insensitive" } },
    ];
  }

  return where;
}

// GET /api/admin/kardex — movimientos paginados, del más reciente al más viejo
router.get("/", async (req, res) => {
  try {
    const where = buildWhere(req);
    const take = Math.min(Number(req.query.take) || 50, 200);
    const skip = Math.max(Number(req.query.skip) || 0, 0);

    const [movimientos, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({ movimientos, total, take, skip });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/kardex/filtros — opciones para los selectores de la pantalla
router.get("/filtros", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    const [acciones, entidades, usuarios] = await Promise.all([
      prisma.auditLog.groupBy({ by: ["accion"], where: { tenantId }, _count: true }),
      prisma.auditLog.groupBy({ by: ["entidad"], where: { tenantId }, _count: true }),
      prisma.auditLog.groupBy({
        by: ["userId", "userNombre", "userEmail"],
        where: { tenantId, userId: { not: null } },
        _count: true,
      }),
    ]);

    res.json({
      acciones: acciones
        .map((a) => ({ valor: a.accion, label: ETIQUETAS[a.accion] || a.accion, total: a._count }))
        .sort((a, b) => b.total - a.total),
      entidades: entidades.filter((e) => e.entidad).map((e) => ({ valor: e.entidad, total: e._count })),
      usuarios: usuarios.map((u) => ({
        id: u.userId,
        nombre: u.userNombre,
        email: u.userEmail,
        total: u._count,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/kardex/export — el mismo filtro, en Excel
router.get("/export", async (req, res) => {
  try {
    const where = buildWhere(req);
    const movimientos = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 10000,
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Kardex");
    sheet.columns = [
      { header: "Fecha", key: "fecha", width: 20 },
      { header: "Usuario", key: "usuario", width: 26 },
      { header: "Correo", key: "correo", width: 30 },
      { header: "Rol", key: "rol", width: 16 },
      { header: "Movimiento", key: "descripcion", width: 40 },
      { header: "Accion", key: "accion", width: 24 },
      { header: "Entidad", key: "entidad", width: 14 },
      { header: "ID", key: "entidadId", width: 10 },
      { header: "Origen", key: "origen", width: 14 },
      { header: "Cambios", key: "cambios", width: 60 },
      { header: "IP", key: "ip", width: 18 },
      { header: "Ruta", key: "ruta", width: 36 },
    ];

    for (const m of movimientos) {
      sheet.addRow({
        fecha: m.createdAt,
        usuario: m.userNombre || "",
        correo: m.userEmail || "",
        rol: m.userRol || "",
        descripcion: m.descripcion,
        accion: m.accion,
        entidad: m.entidad || "",
        entidadId: m.entidadId || "",
        origen: m.origen,
        cambios: m.cambios
          ? Object.entries(m.cambios)
              .map(([k, v]) => `${k}: ${JSON.stringify(v.antes)} -> ${JSON.stringify(v.despues)}`)
              .join(" | ")
          : "",
        ip: m.ip || "",
        ruta: m.ruta || "",
      });
    }
    sheet.getRow(1).font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="kardex.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
