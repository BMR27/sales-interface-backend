const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");
const gestionAdmin = require("../middleware/gestionAdmin");

// Roles que un administrador puede darle a alguien de su espacio. SUPER_ADMIN
// queda fuera: es nivel plataforma y no se reparte desde aqui.
const ROLES_ASIGNABLES = ["ADMIN", "ADMIN_OPERATIVO", "VENDEDOR", "COORDINADOR"];
const { getNextVendedor } = require("../lib/assignment");
const { parseWorkbookBuffer, validateRow, buildTemplateBuffer } = require("../lib/leadsImport");
const { LEAD_STATUSES, parseLeadStatus } = require("../lib/leadStatus");
const { inicioDeHoy, inicioDeSemana, inicioDeMes } = require("../lib/fechasLocales");
const { notificarLeadsImportados } = require("../lib/notificaciones");
const { crearAvisos } = require("../lib/avisos");
const { getParametros } = require("../lib/parametros");
const { detallarMovimiento } = require("../lib/auditoria");

const router = express.Router();
const prisma = require("../lib/prisma");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /\.xlsx$/i.test(file.originalname || ""));
  },
});

// La puerta deja entrar a los dos administradores; lo que no comparten
// (el equipo y las invitaciones a proveedores) lleva `adminMiddleware`
// pegado a su propia ruta, mas abajo.
router.use(authMiddleware, gestionAdmin);

// GET /api/admin/overview
router.get("/overview", async (req, res) => {
  try {
    // Los cortes son los del calendario de la operacion, no los del
    // servidor, que corre en UTC (ver src/lib/fechasLocales.js). Con
    // setHours(0,0,0,0) el "hoy" arrancaba a las 18:00 del dia anterior.
    const ahora = new Date();
    const inicioDia = inicioDeHoy(ahora);
    const inicioSemana = inicioDeSemana(ahora);
    const inicioMes = inicioDeMes(ahora);

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

    // Igual que la API: sin asignacion automatica, una fila sin vendedora
    // explicita entra a la cola en vez de repartirse sola.
    const { asignacionAutomatica } = await getParametros(tenantId);

    const vendedoresCache = new Map();
    async function resolveVendedor(email) {
      if (!email) return asignacionAutomatica ? getNextVendedor(prisma, tenantId) : null;
      const key = String(email).toLowerCase();
      if (vendedoresCache.has(key)) return vendedoresCache.get(key);
      const vendedor = await prisma.user.findFirst({
        where: { email: key, tenantId, rol: "VENDEDOR", activo: true },
      });
      vendedoresCache.set(key, vendedor);
      return vendedor;
    }

    const resultados = { creados: 0, errores: [] };
    const leadsCreados = [];

    for (const { ref, data } of rows) {
      const error = validateRow(data);
      if (error) {
        resultados.errores.push({ fila: ref, error });
        continue;
      }

      const vendedor = await resolveVendedor(data.vendedorEmail);
      // Solo es error si se pidio una vendedora concreta y no existe; sin
      // email es intencional: el lead queda esperando en la cola.
      if (!vendedor && data.vendedorEmail) {
        resultados.errores.push({
          fila: ref,
          error: `Vendedor '${data.vendedorEmail}' no encontrado o inactivo`,
        });
        continue;
      }
      if (!vendedor && asignacionAutomatica) {
        resultados.errores.push({ fila: ref, error: "No hay vendedores activos disponibles" });
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
        const creado = await prisma.lead.create({
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
            vendedorId: vendedor?.id ?? null,
            source: "MANUAL",
            tenantId,
          },
        });
        resultados.creados += 1;
        leadsCreados.push(creado);
      } catch (err) {
        resultados.errores.push({ fila: ref, error: "No se pudo crear el lead" });
      }
    }

    detallarMovimiento(req, {
      descripcion: `Importó ${resultados.creados} leads en lote`,
      despues: { creados: resultados.creados, errores: resultados.errores.length },
    });

    // Un solo correo por carga: un Excel de 500 leads no puede convertirse
    // en 500 avisos (ver src/lib/notificaciones.js).
    notificarLeadsImportados(tenantId, leadsCreados, { importadoPor: req.user.nombre || req.user.email });

    // Y un solo aviso en pantalla por vendedora, con su total: el mismo
    // criterio del correo aplicado a la campana.
    const porVendedora = new Map();
    for (const lead of leadsCreados) {
      if (!lead.vendedorId) continue;
      porVendedora.set(lead.vendedorId, (porVendedora.get(lead.vendedorId) || 0) + 1);
    }
    if (porVendedora.size > 0) {
      crearAvisos(
        Array.from(porVendedora, ([userId, cuantos]) => ({
          userId,
          tenantId,
          tipo: "lead.asignado",
          categoria: "INFO",
          titulo: cuantos === 1 ? "Nuevo lead asignado" : `${cuantos} leads nuevos en tu cola`,
          mensaje: `Se cargaron ${cuantos === 1 ? "un lead" : `${cuantos} leads`} a tu nombre.`,
          enlace: "/leads",
        })),
      );
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
    if (status) {
      const parsed = parseLeadStatus(status);
      if (!parsed) {
        return res.status(400).json({ error: `status inválido. Valores: ${LEAD_STATUSES.join(", ")}` });
      }
      where.status = parsed;
    }
    if (vendedorId) where.vendedorId = parseInt(vendedorId);
    if (source) where.source = source.toUpperCase();
    if (search) {
      where.OR = [
        { nombre: { contains: search, mode: "insensitive" } },
        { producto: { contains: search, mode: "insensitive" } },
        { folio: { contains: search, mode: "insensitive" } },
      ];
    }

    // Los conteos ignoran el filtro de estatus a proposito: son las pastillas
    // con las que se filtra, y tienen que seguir diciendo cuantos hay de cada
    // uno aunque ya se haya elegido uno. Lo demas (busqueda, vendedora,
    // origen) si aplica, o los numeros no corresponderian con la lista.
    const whereSinStatus = { ...where };
    delete whereSinStatus.status;

    const [leads, porStatus, sinAsignar] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        include: { vendedor: { select: { id: true, nombre: true, email: true } } },
      }),
      prisma.lead.groupBy({ by: ["status"], where: whereSinStatus, _count: true }),
      prisma.lead.count({ where: { ...whereSinStatus, vendedorId: null } }),
    ]);

    const conteos = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0]));
    for (const fila of porStatus) conteos[fila.status] = fila._count;

    res.json({
      leads,
      conteos: {
        ...conteos,
        total: Object.values(conteos).reduce((a, b) => a + b, 0),
        sinAsignar,
      },
    });
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
        lead: { select: { nombre: true, producto: true, folio: true, telefono: true, zipCode: true } },
        vendedor: { select: { id: true, nombre: true } },
      },
    });

    const total = ventas.reduce((s, v) => s + v.monto, 0);

    // El filtro de la pantalla es "vendedores": sólo el rol VENDEDOR. Antes
    // se llenaba con /api/admin/vendedores, que devuelve todos los usuarios
    // del espacio -- ahí salían admins, coordinadoras y proveedores de leads,
    // que nunca pueden aparecer en la columna Vendedor de esta tabla.
    const vendedoresDelEspacio = await prisma.user.findMany({
      where: { tenantId: req.user.tenantId, rol: "VENDEDOR" },
      orderBy: { nombre: "asc" },
      select: { id: true, nombre: true, activo: true },
    });

    // El desglose por vendedora se calcula sobre TODAS las ventas del rango,
    // no sobre `ventas` (que puede venir filtrado a una sola persona): si no,
    // al elegir a alguien su participación saldría siempre 100%.
    const whereRango = { tenantId: req.user.tenantId, ...(where.fecha ? { fecha: where.fecha } : {}) };
    const agregadoPorVendedor = await prisma.venta.groupBy({
      by: ["vendedorId"],
      where: whereRango,
      _sum: { monto: true, comision: true },
      _count: true,
    });
    const montoGlobal = agregadoPorVendedor.reduce((s, r) => s + (r._sum.monto || 0), 0);

    const nombrePorId = new Map(vendedoresDelEspacio.map((v) => [v.id, v]));
    const porVendedor = agregadoPorVendedor
      .map((r) => {
        const monto = r._sum.monto || 0;
        return {
          id: r.vendedorId,
          // Una venta vieja puede apuntar a alguien que ya no es VENDEDOR (o
          // que se dio de baja): se muestra igual, el dinero existió.
          nombre: nombrePorId.get(r.vendedorId)?.nombre || "Usuario dado de baja",
          activo: nombrePorId.get(r.vendedorId)?.activo ?? false,
          ventas: r._count,
          monto,
          comision: r._sum.comision || 0,
          ticket: r._count > 0 ? Math.round(monto / r._count) : 0,
          participacion: montoGlobal > 0 ? Math.round((monto / montoGlobal) * 100) : 0,
        };
      })
      .sort((a, b) => b.monto - a.monto);

    // Serie diaria del conjunto filtrado, para la gráfica.
    const serie = new Map();
    for (const v of ventas) {
      const dia = new Date(v.fecha).toISOString().slice(0, 10);
      const e = serie.get(dia) || { dia, monto: 0, ventas: 0, comision: 0 };
      e.monto += v.monto;
      e.comision += v.comision;
      e.ventas += 1;
      serie.set(dia, e);
    }

    const porProducto = new Map();
    for (const v of ventas) {
      const nombre = v.lead?.producto || "Sin producto";
      const e = porProducto.get(nombre) || { producto: nombre, ventas: 0, monto: 0 };
      e.ventas += 1;
      e.monto += v.monto;
      porProducto.set(nombre, e);
    }

    res.json({
      ventas,
      total,
      resumen: {
        count: ventas.length,
        monto: total,
        comision: ventas.reduce((s, v) => s + v.comision, 0),
        envio: ventas.reduce((s, v) => s + (v.costoEnvio || 0), 0),
        ticket: ventas.length > 0 ? Math.round(total / ventas.length) : 0,
        entregadas: ventas.filter((v) => v.entregaExitosa).length,
        prepago: ventas.filter((v) => v.fullvectorSinCobertura).length,
        sinSincronizar: ventas.filter((v) => v.fullvectorSyncStatus !== "SYNCED").length,
      },
      porVendedor,
      vendedores: vendedoresDelEspacio,
      serie: Array.from(serie.values()).sort((a, b) => a.dia.localeCompare(b.dia)),
      topProductos: Array.from(porProducto.values()).sort((a, b) => b.monto - a.monto).slice(0, 6),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/vendedores
router.get("/vendedores", adminMiddleware, async (req, res) => {
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
router.post("/vendedores", adminMiddleware, async (req, res) => {
  try {
    const { nombre, email, password, rol } = req.body;
    if (!nombre || !email || !password) {
      return res.status(400).json({ error: "Nombre, email y contraseña requeridos" });
    }
    const rolFinal = rol || "VENDEDOR";
    if (!ROLES_ASIGNABLES.includes(rolFinal)) {
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
router.put("/vendedores/:id", adminMiddleware, async (req, res) => {
  try {
    const { nombre, email, rol, activo } = req.body;
    if (rol !== undefined && !ROLES_ASIGNABLES.includes(rol)) {
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
router.post("/proveedores/invitacion", adminMiddleware, async (req, res) => {
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
