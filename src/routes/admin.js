const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");
const gestionAdmin = require("../middleware/gestionAdmin");
const { siguienteFolio } = require("../lib/folios");

// Roles que un administrador puede darle a alguien de su espacio. SUPER_ADMIN
// queda fuera: es nivel plataforma y no se reparte desde aqui.
const ROLES_ASIGNABLES = ["ADMIN", "ADMIN_OPERATIVO", "VENDEDOR", "COORDINADOR"];
const { getNextVendedor } = require("../lib/assignment");
const { parseWorkbookBuffer, validateRow, buildTemplateBuffer } = require("../lib/leadsImport");
const { LEAD_STATUSES, LEAD_STATUSES_CERRADOS_SIN_VENTA, parseLeadStatus } = require("../lib/leadStatus");
const { inicioDeHoy, inicioDeSemana, inicioDeMes, inicioDeDia, finDeDia } = require("../lib/fechasLocales");
const { notificarLeadsImportados } = require("../lib/notificaciones");
const { crearAvisos } = require("../lib/avisos");
const { getParametros } = require("../lib/parametros");
const { detallarMovimiento } = require("../lib/auditoria");
const { ROLES_PRESTABLES_A_ADMIN, construirVistaPrestada } = require("../lib/impersonacion");
const crypto = require("crypto");
const { hashKey } = require("../middleware/apiKey");
const { revocarSesiones } = require("../lib/sesiones");
const { MOTIVOS_REACTIVABLES, dondeReactivable, reactivar } = require("../lib/reactivacionLeads");
const { motivoLabel } = require("../lib/motivosDescarte");
const { describirLeads } = require("../lib/semaforoLead");
const { dondeRepartible, dondeEnEspera } = require("../lib/colaLeads");
const { cronologiaDeLead } = require("../lib/cronologiaLead");
const { emitir } = require("../lib/eventos");
const { DIAS, validarRango, horariosDe } = require("../lib/horariosVendedora");

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
            folioPS: await siguienteFolio(req.user.tenantId),
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
            asignadoAt: vendedor ? new Date() : null,
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
    const { status, vendedorId, search, source, cola } = req.query;
    const where = { tenantId: req.user.tenantId };

    // Las dos mitades de la cola, que hasta ahora solo sabia separar la
    // coordinadora: el aviso del tablero decia "19 sin asignar · 34 en
    // espera" y al entrar aparecia la lista completa, sin forma de saber
    // cuales eran cuales.
    //
    // Van en AND y no mezclados en `where` para no pisar el filtro de
    // estatus ni el OR de la busqueda, que ya viven ahi.
    const filtrosCola = [];
    if (cola === "sin_asignar") filtrosCola.push(dondeRepartible(req.user.tenantId));
    else if (cola === "en_espera") filtrosCola.push(dondeEnEspera(req.user.tenantId));
    else if (cola === "asignados") filtrosCola.push({ vendedorId: { not: null } });
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
        // El folio interno es justo para esto: buscar un lead concreto
        // cuando el nombre llego mal capturado desde el proveedor.
        { folioPS: { contains: search, mode: "insensitive" } },
      ];
    }

    // Los conteos ignoran el filtro de estatus a proposito: son las pastillas
    // con las que se filtra, y tienen que seguir diciendo cuantos hay de cada
    // uno aunque ya se haya elegido uno. Lo demas (busqueda, vendedora,
    // origen) si aplica, o los numeros no corresponderian con la lista.
    if (filtrosCola.length > 0) where.AND = [...(where.AND ?? []), ...filtrosCola];

    const whereSinStatus = { ...where };
    delete whereSinStatus.status;

    const [leads, porStatus, sinAsignar, enEspera] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        include: {
          vendedor: { select: { id: true, nombre: true, email: true } },
          // El administrador necesita el mismo semaforo y los mismos
          // relojes que la coordinadora: un lead bloqueado o a punto de
          // caducar se ve igual mire quien lo mire.
          _count: { select: { llamadas: true } },
          llamadas: { orderBy: { fecha: "desc" }, take: 1, select: { fecha: true, desenlace: true, contestada: true } },
        },
      }),
      prisma.lead.groupBy({ by: ["status"], where: whereSinStatus, _count: true }),
      prisma.lead.count({ where: dondeRepartible(req.user.tenantId) }),
      prisma.lead.count({ where: dondeEnEspera(req.user.tenantId) }),
    ]);

    const conteos = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0]));
    for (const fila of porStatus) conteos[fila.status] = fila._count;

    const descripciones = await describirLeads(
      leads,
      req.user.tenantId,
      new Map(leads.map((l) => [l.id, {
        intentos: l._count.llamadas,
        ultimaLlamada: l.llamadas[0] ?? null,
      }]))
    );

    res.json({
      leads: leads.map((l, i) => {
        const { _count, llamadas, ...lead } = l;
        return { ...lead, ...descripciones[i] };
      }),
      conteos: {
        ...conteos,
        total: Object.values(conteos).reduce((a, b) => a + b, 0),
        sinAsignar,
        enEspera,
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
      // asignadoAt: la reasignacion es trabajo del dia en que se hace, no
      // del dia en que el lead entro (ver el reporte de Progreso).
      data: { vendedorId, asignadoAt: new Date() },
      include: { vendedor: { select: { id: true, nombre: true } } },
    });

    emitir(req.user.tenantId, "lead.reasignado", { leadId: lead.id });
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
// Leer el equipo NO es administrarlo: el administrador de operacion
// necesita la lista para poder asignar leads, que es parte de su trabajo.
// Lo que queda cerrado a ADMIN es dar de alta, editar y desactivar, mas
// abajo. Sin esto el desplegable de asignacion salia vacio y en silencio,
// porque la pantalla se come el 403.
router.get("/vendedores", gestionAdmin, async (req, res) => {
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

// GET /api/admin/vendedores/:id/horario — el turno de una vendedora.
//
// Lo necesita una sola regla, pero es la que decide a donde va el lead:
// cuando el cliente pide que le llamen hoy mas tarde, la rellamada se queda
// con ella SOLO si esa hora cae dentro de su turno (ver
// src/lib/horariosVendedora.js). Sin horario configurado, el lead va a la
// coordinadora marcado para que alguien revise la disponibilidad -- es
// deliberado, no un error: prometerle al cliente una llamada a las 8 de la
// noche dejandosela a alguien de quien no sabemos si trabaja a esa hora es
// peor que pasarla a quien si puede decidir.
router.get("/vendedores/:id/horario", gestionAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const vendedora = await prisma.user.findFirst({
      where: { id: userId, tenantId: req.user.tenantId },
      select: { id: true, nombre: true, rol: true },
    });
    if (!vendedora) return res.status(404).json({ error: "Usuario no encontrado" });

    res.json({
      vendedora,
      horarios: await horariosDe(userId, req.user.tenantId),
      dias: DIAS,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// PUT /api/admin/vendedores/:id/horario — reemplaza el turno completo.
//
// Reemplazo y no actualizacion parcial: un turno es un conjunto de franjas
// que se lee de corrido, y editarlas de una en una deja estados intermedios
// imposibles (el martes sin horario entre dos guardados) justo mientras el
// enrutamiento de rellamadas los esta consultando.
router.put("/vendedores/:id/horario", adminMiddleware, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const vendedora = await prisma.user.findFirst({
      where: { id: userId, tenantId: req.user.tenantId },
      select: { id: true, nombre: true },
    });
    if (!vendedora) return res.status(404).json({ error: "Usuario no encontrado" });

    const entrada = Array.isArray(req.body?.horarios) ? req.body.horarios : [];
    if (entrada.length > 21) {
      return res.status(400).json({ error: "Demasiadas franjas: máximo 3 por día" });
    }

    // Se valida TODO antes de escribir nada: medio horario guardado es peor
    // que ninguno, porque las rellamadas se enrutarian contra un turno que
    // nadie capturo asi.
    const franjas = [];
    for (const f of entrada) {
      const r = validarRango(f);
      if (r.error) return res.status(400).json({ error: r.error });
      franjas.push(r.valor);
    }

    // Franjas del mismo dia que se enciman: no son un error de captura
    // cualquiera, significan que el turno dice dos cosas distintas sobre la
    // misma hora y la regla de "dentro del turno" dejaria de ser una sola.
    const porDia = new Map();
    for (const f of franjas) {
      if (!porDia.has(f.diaSemana)) porDia.set(f.diaSemana, []);
      porDia.get(f.diaSemana).push(f);
    }
    for (const [dia, lista] of porDia) {
      const ordenadas = lista.slice().sort((a, b) => a.horaInicio - b.horaInicio);
      for (let i = 1; i < ordenadas.length; i++) {
        if (ordenadas[i].horaInicio < ordenadas[i - 1].horaFin) {
          return res.status(400).json({ error: `${DIAS[dia]}: hay dos franjas que se enciman` });
        }
      }
    }

    const antes = await horariosDe(userId, req.user.tenantId);

    await prisma.$transaction([
      prisma.horarioVendedora.deleteMany({ where: { userId, tenantId: req.user.tenantId } }),
      ...(franjas.length
        ? [
            prisma.horarioVendedora.createMany({
              data: franjas.map((f) => ({ ...f, userId, tenantId: req.user.tenantId })),
            }),
          ]
        : []),
    ]);

    detallarMovimiento(req, {
      entidad: "User",
      entidadId: userId,
      descripcion: `Configuró el horario de ${vendedora.nombre}`,
      antes: { franjas: antes.length },
      despues: { franjas: franjas.length },
    });

    res.json({ horarios: await horariosDe(userId, req.user.tenantId) });
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

// GET /api/admin/leads/:id/cronologia — la historia completa de un lead.
router.get("/leads/:id/cronologia", async (req, res) => {
  try {
    const cronologia = await cronologiaDeLead(parseInt(req.params.id), req.user.tenantId);
    if (!cronologia) return res.status(404).json({ error: "Lead no encontrado" });
    res.json(cronologia);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/leads/reactivables — cuantos descartados volverian a la
// cola con el filtro dado, antes de tocar nada.
//
// La vista previa no es un adorno: devolver leads a la cola es masivo y no
// tiene deshacer, asi que el admin tiene que poder ver el numero y el
// desglose por motivo antes de confirmarlo.
router.get("/leads/reactivables", adminMiddleware, async (req, res) => {
  try {
    const { motivos, desde, hasta, q } = req.query;
    const where = dondeReactivable(req.user.tenantId, {
      motivos: motivos ? String(motivos).split(",") : undefined,
      desde: desde ? inicioDeDia(desde) : undefined,
      hasta: hasta ? finDeDia(hasta) : undefined,
      busqueda: q,
    });

    const porMotivo = await prisma.lead.groupBy({
      by: ["motivoDescarte"],
      where,
      _count: true,
    });

    // Buscando un lead concreto se devuelve la lista, no solo el conteo:
    // el admin tiene que ver cual es y por que se descarto antes de
    // devolverlo a la cola.
    const leads = q
      ? await prisma.lead.findMany({
          where,
          select: {
            id: true, folioPS: true, nombre: true, telefono: true,
            motivoDescarte: true, descartadoAt: true,
          },
          orderBy: { descartadoAt: "desc" },
          take: 50,
        })
      : [];

    res.json({
      total: porMotivo.reduce((s, m) => s + m._count, 0),
      porMotivo: porMotivo.map((m) => ({
        motivo: m.motivoDescarte,
        label: motivoLabel(m.motivoDescarte),
        total: m._count,
      })),
      motivosPermitidos: MOTIVOS_REACTIVABLES.map((m) => ({ motivo: m, label: motivoLabel(m) })),
      leads: leads.map((l) => ({
        ...l,
        motivoLabel: motivoLabel(l.motivoDescarte),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/admin/leads/reactivar — los devuelve a la cola.
router.post("/leads/reactivar", adminMiddleware, async (req, res) => {
  try {
    const { motivos, desde, hasta, ids } = req.body || {};

    // Con ids explicitos se reactivan esos y nada mas: es el caso de
    // "este lead se descarto por error", donde el admin ya vio cual es.
    // El tenantId sigue en el where, asi que no se puede reactivar un lead
    // de otra empresa mandando su id.
    const where = Array.isArray(ids) && ids.length > 0
      ? { tenantId: req.user.tenantId, status: { in: LEAD_STATUSES_CERRADOS_SIN_VENTA }, id: { in: ids.map(Number).filter(Number.isFinite) } }
      : dondeReactivable(req.user.tenantId, {
          motivos: Array.isArray(motivos) ? motivos : undefined,
          desde: desde ? inicioDeDia(desde) : undefined,
          hasta: hasta ? finDeDia(hasta) : undefined,
        });

    const leads = await prisma.lead.findMany({ where, select: { id: true } });
    if (leads.length === 0) {
      return res.json({ reactivados: 0, message: "Ningun lead coincide con ese filtro" });
    }

    const reactivados = await reactivar({
      tenantId: req.user.tenantId,
      ids: leads.map((l) => l.id),
      motivo: "Reactivado por el administrador para volver a llamar",
      porNombre: req.user.nombre,
    });

    detallarMovimiento(req, {
      entidadId: null,
      descripcion: `Devolvió ${reactivados} leads descartados a la cola`,
      despues: { motivos: motivos ?? MOTIVOS_REACTIVABLES, desde: desde ?? null, hasta: hasta ?? null },
    });

    emitir(req.user.tenantId, "leads.reactivados", { total: reactivados });
    res.json({ reactivados, message: `${reactivados} leads volvieron a la cola` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// PUT /api/admin/vendedores/:id/password — establece una contraseña nueva
// para alguien del espacio.
//
// No habia forma de recuperar una contraseña: no existe "olvide mi
// contraseña" y se guardan con bcrypt, que es de ida sola. Quien la perdia
// quedaba fuera del sistema sin remedio -- y con proveedores externos
// entrando al portal, eso dejo de ser un caso raro.
//
// Otro ADMIN queda fuera, igual que en "Ver como": cambiarle la contraseña
// a un par es tomar su cuenta, y no hay razon de operacion que lo pida.
router.put("/vendedores/:id/password", adminMiddleware, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres" });
    }

    const usuario = await prisma.user.findFirst({
      where: { id: Number(req.params.id), tenantId: req.user.tenantId },
      select: { id: true, nombre: true, rol: true },
    });
    if (!usuario) return res.status(404).json({ error: "Usuario no encontrado en tu espacio" });
    if (usuario.id === req.user.id) {
      return res.status(400).json({ error: "Tu propia contraseña se cambia desde Mi Perfil" });
    }
    if (usuario.rol === "ADMIN" || usuario.rol === "SUPER_ADMIN") {
      return res.status(403).json({ error: "No puedes cambiar la contraseña de otro administrador" });
    }

    await prisma.user.update({
      where: { id: usuario.id },
      data: { password: await bcrypt.hash(String(password), 10) },
    });

    // Si alguien tenia esa cuenta abierta, la contraseña nueva no deberia
    // dejarlo seguir dentro: es justo el caso de "creo que alguien mas la
    // tiene". Vuelve a pedir login con la credencial nueva.
    await revocarSesiones(usuario.id, { motivo: "cerrada_por_usuario" });

    detallarMovimiento(req, {
      entidadId: usuario.id,
      descripcion: `Restableció la contraseña de ${usuario.nombre}`,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/admin/vendedores/:id/api-key — genera (o regenera) la API key
// de un proveedor de leads del espacio.
//
// Vive aqui y no en el portal del proveedor porque regenerar revoca la key
// anterior al instante: la integracion del proveedor deja de funcionar sin
// aviso. Quien puede coordinar ese cambio es el administrador.
//
// La key completa se devuelve UNA sola vez, aqui. De la base no se puede
// recuperar: se guarda hasheada (keyHash), que es lo que impide que un
// volcado de la tabla sirva para mandar leads en nombre del proveedor.
router.post("/vendedores/:id/api-key", adminMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const proveedor = await prisma.user.findFirst({
      where: { id, tenantId: req.user.tenantId, rol: "PROVEEDOR_LEADS" },
      select: { id: true, nombre: true, activo: true },
    });
    if (!proveedor) return res.status(404).json({ error: "Proveedor no encontrado en tu espacio" });
    if (!proveedor.activo) {
      return res.status(400).json({ error: "El proveedor está inactivo: actívalo antes de darle una key" });
    }

    await prisma.apiKey.updateMany({
      where: { createdByUserId: proveedor.id, tenantId: req.user.tenantId, active: true },
      data: { active: false },
    });

    const fullKey = `sk_${crypto.randomBytes(24).toString("hex")}`;
    const apiKey = await prisma.apiKey.create({
      data: {
        label: `Proveedor de leads - ${proveedor.nombre}`,
        keyPrefix: fullKey.slice(0, 12),
        keyHash: hashKey(fullKey),
        tenantId: req.user.tenantId,
        // La key sigue colgando del proveedor, no del admin: es lo que hace
        // que sus leads y su portal la reconozcan como suya.
        createdByUserId: proveedor.id,
      },
    });

    detallarMovimiento(req, {
      entidadId: proveedor.id,
      descripcion: `Generó una API key nueva para ${proveedor.nombre}`,
    });

    res.status(201).json({
      id: apiKey.id,
      label: apiKey.label,
      keyPrefix: apiKey.keyPrefix,
      key: fullKey,
      createdAt: apiKey.createdAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/ver-como — a quien puede ver el administrador de este
// espacio. Es su propia gente: la vista de una coordinadora o una vendedora
// es la de una persona concreta (su cola, sus leads), asi que hay que
// elegirla. Otro ADMIN queda fuera -- no daria ningun permiso nuevo y si
// borraria el rastro de quien actuo.
router.get("/ver-como", adminMiddleware, async (req, res) => {
  try {
    const usuarios = await prisma.user.findMany({
      where: {
        tenantId: req.user.tenantId,
        activo: true,
        rol: { in: ROLES_PRESTABLES_A_ADMIN },
        id: { not: req.user.id },
      },
      select: { id: true, nombre: true, email: true, rol: true },
      orderBy: [{ rol: "asc" }, { nombre: "asc" }],
    });

    res.json({ usuarios });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/admin/ver-como — toma prestada la vista de alguien del espacio.
//
// No consume la sesion de esa persona ni la saca de la aplicacion: el token
// es aparte y dura una hora. Lo que se haga queda a su nombre, por eso
// lleva `impersonatedBy` y la pantalla avisa con una banda fija.
router.post("/ver-como", adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId requerido" });

    const usuario = await prisma.user.findFirst({
      where: { id: Number(userId), tenantId: req.user.tenantId, activo: true },
      select: { id: true, nombre: true, email: true, rol: true },
    });
    if (!usuario) return res.status(404).json({ error: "Usuario no encontrado en tu espacio" });
    if (!ROLES_PRESTABLES_A_ADMIN.includes(usuario.rol)) {
      return res.status(400).json({ error: "No se puede ver como ese rol" });
    }
    if (usuario.id === req.user.id) {
      return res.status(400).json({ error: "Esa ya es tu propia vista" });
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId } });
    if (!tenant) return res.status(404).json({ error: "Espacio no encontrado" });

    detallarMovimiento(req, {
      entidadId: usuario.id,
      descripcion: `Entró a ver el sistema como ${usuario.nombre}`,
    });

    res.json(construirVistaPrestada({ tenant, usuario, porId: req.user.id }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
