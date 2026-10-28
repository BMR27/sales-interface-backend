const express = require("express");
const ExcelJS = require("exceljs");
const authMiddleware = require("../middleware/auth");
const coordinacionMiddleware = require("../middleware/coordinacion");
const { detallarMovimiento } = require("../lib/auditoria");
const { getParametros } = require("../lib/parametros");
const { calcularQuincenaVendedora, calcularQuincenaCoordinadoras } = require("../lib/comisiones");
const { crearAviso, crearAvisos } = require("../lib/avisos");

const router = express.Router();
const prisma = require("../lib/prisma");
const { inicioDeDia, finDeDia, inicioDeHoy, diaLocal } = require("../lib/fechasLocales");

router.use(authMiddleware, coordinacionMiddleware);

// Agrupaciones que usa el coordinador en su historial. Con cuatro estatus
// cada grupo es uno solo, pero se mantiene la forma de lista porque los
// nombres de grupo son parte del contrato del filtro ?estado=.
const STATUS_GROUPS = {
  PENDIENTE: ["NUEVO"],
  CONCRETADA: ["VENTA"],
  RECHAZADA: ["DESCARTADO"],
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
    // Hora de la operacion, no del servidor en UTC (fechasLocales.js).
    const inicioDia = inicioDeHoy();

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

    const totales = { asignados: 0, sinAsignar: 0, pendientes: 0, concretadas: 0, rechazadas: 0, reagendadas: 0 };

    for (const row of grouped) {
      const bucket = porVendedor[row.vendedorId];
      const key = classify(row.status);
      const field = key === "pendiente" ? "pendientes" : key === "concretada" ? "concretadas" : key === "rechazada" ? "rechazadas" : "reagendadas";
      // Un lead sin vendedora no esta asignado a nadie: contarlo en
      // "asignados" inflaba el tablero con la propia cola por repartir.
      if (row.vendedorId == null) {
        totales.sinAsignar += row._count;
        continue;
      }
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
    const { state, productoId, search, asignacion } = req.query;
    const where = { tenantId: req.user.tenantId };

    // Los dos filtros de abajo son OR por dentro, asi que van en un AND:
    // asignarlos los dos a where.OR haria que el segundo pisara al primero.
    const filtros = [];

    // La cola de trabajo son los leads sin vendedora: con asignacion manual
    // es lo que el coordinador tiene que repartir. "asignados" y "todos"
    // quedan disponibles para consultar.
    // "pendientes" es estrictamente lo que no tiene vendedora, para que la
    // lista cuadre con el contador `sinAsignar` que va en el mismo response.
    // Un lead ya repartido se consulta y se reasigna desde "asignados".
    if (asignacion === "asignados") {
      where.vendedorId = { not: null };
    } else if (asignacion !== "todos") {
      where.vendedorId = null;
    }

    if (state) where.state = state;
    if (productoId) where.productoId = parseInt(productoId);
    if (search) {
      filtros.push({
        OR: [
          { nombre: { contains: search, mode: "insensitive" } },
          { producto: { contains: search, mode: "insensitive" } },
        ],
      });
    }
    if (filtros.length > 0) where.AND = filtros;

    const [leads, sinAsignar] = await Promise.all([
      prisma.lead.findMany({
        where,
        // Los que no tienen vendedora van arriba: son los que esperan.
        orderBy: [{ vendedorId: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
        take: 100,
        include: { vendedor: { select: { id: true, nombre: true } } },
      }),
      prisma.lead.count({ where: { tenantId: req.user.tenantId, vendedorId: null } }),
    ]);

    res.json({ leads, sinAsignar });
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

    const ids = leadIds.map(Number).filter(Number.isInteger);
    const antes = await prisma.lead.findMany({
      where: { id: { in: ids }, tenantId: req.user.tenantId },
      select: { id: true, nombre: true, vendedor: { select: { id: true, nombre: true } } },
    });
    if (antes.length === 0) return res.status(404).json({ error: "No se encontraron esos leads" });

    const result = await prisma.lead.updateMany({
      where: { id: { in: antes.map((l) => l.id) }, tenantId: req.user.tenantId },
      // Queda registrado quien repartio: es a esa coordinadora a la que se
      // le acredita la comision por la venta que salga del lead.
      data: { vendedorId: vendedor.id, asignadoPorCoordinador: true, asignadoPorId: req.user.id },
    });

    // El kardex necesita saber a quien se le quito el lead, no solo a quien
    // se le dio: una reasignacion sin el "antes" no se puede auditar.
    detallarMovimiento(req, {
      entidadId: antes.length === 1 ? antes[0].id : null,
      descripcion:
        antes.length === 1
          ? `Asignó el lead ${antes[0].nombre} a ${vendedor.nombre}`
          : `Asignó ${antes.length} leads a ${vendedor.nombre}`,
      antes: {
        leads: antes.map((l) => ({ id: l.id, nombre: l.nombre, vendedor: l.vendedor?.nombre ?? "sin asignar" })),
      },
      despues: { vendedor: vendedor.nombre, leads: antes.map((l) => l.id) },
    });

    // La vendedora se entera de que le cayó trabajo sin tener que recargar
    // la cola. Un aviso por lead cuando son pocos; uno solo cuando es un
    // lote, para no llenarle la campana de veinte líneas iguales.
    if (antes.length <= 3) {
      crearAvisos(
        antes.map((l) => ({
          userId: vendedor.id,
          tenantId: req.user.tenantId,
          tipo: "lead.asignado",
          categoria: "INFO",
          titulo: "Nuevo lead asignado",
          mensaje: `${l.nombre} está en tu cola, asignado por ${req.user.nombre}.`,
          enlace: "/leads",
        })),
      );
    } else {
      crearAviso({
        userId: vendedor.id,
        tenantId: req.user.tenantId,
        tipo: "lead.asignado",
        categoria: "INFO",
        titulo: `${antes.length} leads nuevos en tu cola`,
        mensaje: `${req.user.nombre} te asignó ${antes.length} leads. Empieza por los más recientes.`,
        enlace: "/leads",
      });
    }

    const sinAsignar = await prisma.lead.count({
      where: { tenantId: req.user.tenantId, vendedorId: null },
    });

    res.json({ message: "Leads asignados", actualizados: result.count, sinAsignar });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/coordinador/progreso?fecha=  |  ?desde=&hasta=
//
// Un dia, una semana o un rango. `fecha` se conserva porque es lo que
// pedia la pantalla antes; `desde`/`hasta` es lo general y un solo dia es
// el caso de desde == hasta.
router.get("/progreso", async (req, res) => {
  try {
    // Las fechas que llegan ("2026-10-26") son dias del calendario de quien
    // las escribe, no instantes UTC: sin esto el corte perdia todo lo
    // ocurrido despues de las 18:00 (ver src/lib/fechasLocales.js).
    const { fecha, desde, hasta } = req.query;
    const inicio = desde ? inicioDeDia(desde) : fecha ? inicioDeDia(fecha) : inicioDeHoy();
    const fin = hasta
      ? finDeDia(hasta)
      : desde
        ? finDeDia(desde)
        : new Date(inicio.getTime() + 86400000);

    if (!inicio || !fin || fin < inicio) {
      return res.status(400).json({ error: "Rango de fechas invalido" });
    }

    const tenantId = req.user.tenantId;

    const [leads, vendedoras] = await Promise.all([
      prisma.lead.findMany({
        where: { tenantId, createdAt: { gte: inicio, lte: fin } },
        orderBy: { createdAt: "desc" },
        include: {
          vendedor: { select: { id: true, nombre: true } },
          items: { include: { producto: { select: { nombre: true } } } },
          venta: { select: { monto: true } },
        },
      }),
      prisma.user.findMany({
        where: { tenantId, rol: "VENDEDOR", activo: true },
        select: { id: true, nombre: true },
      }),
    ]);

    // Intentos de llamada de esos leads. Es lo que separa "nadie le ha
    // marcado" de "le marcaron y no contesta": sin este dato la pantalla
    // no puede decir que es lo que de verdad necesita atencion.
    const intentos = leads.length
      ? await prisma.llamada.groupBy({
          by: ["leadId"],
          where: { tenantId, leadId: { in: leads.map((l) => l.id) } },
          _count: true,
        })
      : [];
    const intentosPorLead = Object.fromEntries(intentos.map((i) => [i.leadId, i._count]));

    const ahora = new Date();

    // Corte del dia: lo que la coordinadora quiere saber de un vistazo.
    const resumen = {
      total: leads.length,
      sinAsignar: 0,
      sinIntentos: 0,
      nuevos: 0,
      reagendados: 0,
      concretados: 0,
      descartados: 0,
      monto: 0,
    };

    // Reagendados cuya hora ya paso: son los que se van a perder si nadie
    // los retoma hoy, y hoy no aparecian en ningun lado.
    const vencidos = [];

    const porVendedora = Object.fromEntries(
      vendedoras.map((v) => [v.id, {
        id: v.id, nombre: v.nombre,
        asignados: 0, sinIntentos: 0, concretados: 0, descartados: 0, abiertos: 0, monto: 0,
      }])
    );

    for (const lead of leads) {
      const n = intentosPorLead[lead.id] ?? 0;
      if (n === 0) resumen.sinIntentos += 1;
      if (!lead.vendedorId) resumen.sinAsignar += 1;

      if (lead.status === "NUEVO") resumen.nuevos += 1;
      else if (lead.status === "REAGENDADO") resumen.reagendados += 1;
      else if (lead.status === "VENTA") resumen.concretados += 1;
      else if (lead.status === "DESCARTADO") resumen.descartados += 1;

      const monto = lead.venta?.monto ?? 0;
      resumen.monto += monto;

      if (lead.status === "REAGENDADO" && lead.fechaReagenda && new Date(lead.fechaReagenda) < ahora) {
        vencidos.push(lead.id);
      }

      const b = porVendedora[lead.vendedorId];
      if (b) {
        b.asignados += 1;
        if (n === 0) b.sinIntentos += 1;
        if (lead.status === "VENTA") { b.concretados += 1; b.monto += monto; }
        else if (lead.status === "DESCARTADO") b.descartados += 1;
        else b.abiertos += 1;
      }
    }

    // Corte dia por dia. Con un solo dia no aporta nada y se omite; con una
    // semana o un rango es justo la pregunta ("¿que dia se cayo?").
    const porDia = new Map();
    for (const lead of leads) {
      const dia = diaLocal(lead.createdAt);
      if (!porDia.has(dia)) porDia.set(dia, { dia, total: 0, concretados: 0, descartados: 0, monto: 0 });
      const d = porDia.get(dia);
      d.total += 1;
      if (lead.status === "VENTA") { d.concretados += 1; d.monto += lead.venta?.monto ?? 0; }
      else if (lead.status === "DESCARTADO") d.descartados += 1;
    }
    const serie = Array.from(porDia.values()).sort((a, b) => a.dia.localeCompare(b.dia));

    const equipo = Object.values(porVendedora)
      .map((v) => ({ ...v, conversion: v.asignados > 0 ? Math.round((v.concretados / v.asignados) * 100) : 0 }))
      .sort((a, b) => b.concretados - a.concretados || b.asignados - a.asignados);

    res.json({
      fecha: inicio,
      desde: inicio,
      hasta: fin,
      dias: serie.length,
      total: leads.length,
      resumen,
      serie,
      equipo,
      leads: leads.map((l) => ({
        ...l,
        intentos: intentosPorLead[l.id] ?? 0,
        reagendaVencida: vencidos.includes(l.id),
        monto: l.venta?.monto ?? null,
      })),
    });
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
      { folioPS: { contains: search, mode: "insensitive" } },
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
      include: {
        vendedor: { select: { nombre: true } },
        // El folio y el estado del envio viven en la venta, no en el lead:
        // sin esto el reporte no servia para dar seguimiento al cierre.
        venta: {
          select: {
            folio: true, monto: true, comision: true, costoEnvio: true, fecha: true,
            entregaExitosa: true, fullvectorOrderId: true, fullvectorSinCobertura: true,
            fullvectorSyncStatus: true,
          },
        },
        llamadas: { select: { fecha: true }, orderBy: { fecha: "asc" }, take: 1 },
        _count: { select: { llamadas: true } },
      },
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "PerfectSelft";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Historial", {
      views: [{ state: "frozen", ySplit: 1 }],
    });

    sheet.columns = [
      { header: "Folio", key: "folio", width: 16 },
      { header: "Estatus", key: "estatus", width: 13 },
      { header: "Fecha del lead", key: "fecha", width: 18 },
      { header: "Fecha de venta", key: "fechaVenta", width: 18 },
      { header: "Vendedora", key: "vendedor", width: 26 },
      { header: "Cliente", key: "cliente", width: 26 },
      { header: "Telefono", key: "telefono", width: 16 },
      { header: "Producto", key: "producto", width: 24 },
      { header: "Monto", key: "monto", width: 13 },
      { header: "Envio", key: "envio", width: 11 },
      { header: "Total cobrado", key: "total", width: 14 },
      { header: "Comision", key: "comision", width: 12 },
      { header: "Calle", key: "calle", width: 26 },
      { header: "Numero", key: "numero", width: 10 },
      { header: "Colonia", key: "colonia", width: 22 },
      { header: "Municipio", key: "municipio", width: 20 },
      { header: "Estado", key: "estado", width: 18 },
      { header: "CP", key: "cp", width: 9 },
      { header: "Referencias", key: "referencias", width: 42 },
      { header: "Entrega", key: "entrega", width: 16 },
      { header: "ID FullVector", key: "fullvector", width: 28 },
      { header: "Llamadas", key: "llamadas", width: 10 },
      { header: "1a llamada", key: "primeraLlamada", width: 18 },
    ];

    const COLOR_ESTATUS = {
      concretada: "FF1B9247",
      rechazada: "FFC0392B",
      reagendada: "FFB8860B",
      pendiente: "FF6B7280",
    };

    for (const lead of leads) {
      const v = lead.venta;
      const estatus = classify(lead.status);
      const fila = sheet.addRow({
        folio: v?.folio || lead.folio || "",
        estatus,
        fecha: lead.createdAt,
        fechaVenta: v?.fecha || "",
        vendedor: lead.vendedor?.nombre || "Sin asignar",
        cliente: lead.nombre,
        telefono: lead.telefono,
        producto: lead.producto,
        monto: v?.monto ?? lead.monto ?? "",
        envio: v?.costoEnvio ?? "",
        total: v ? v.monto + (v.costoEnvio || 0) : "",
        comision: v?.comision ?? "",
        calle: lead.shippingStreet || "",
        numero: lead.shippingNumber || "",
        colonia: lead.colonia || "",
        municipio: lead.municipio || "",
        estado: lead.state || "",
        cp: lead.zipCode || "",
        referencias: lead.shippingReferences || "",
        entrega: !v
          ? ""
          : v.fullvectorSyncStatus !== "SYNCED"
            ? "No llego a FullVector"
            : v.fullvectorSinCobertura
              ? "Prepago (sin COD)"
              : v.entregaExitosa
                ? "Entregada"
                : "En transito",
        fullvector: v?.fullvectorOrderId || "",
        llamadas: lead._count.llamadas,
        primeraLlamada: lead.llamadas[0]?.fecha || "",
      });

      fila.getCell("estatus").font = { bold: true, color: { argb: COLOR_ESTATUS[estatus] } };
      for (const key of ["monto", "envio", "total", "comision"]) {
        fila.getCell(key).numFmt = '"$"#,##0.00';
      }
      for (const key of ["fecha", "fechaVenta", "primeraLlamada"]) {
        fila.getCell(key).numFmt = "dd/mm/yyyy hh:mm";
      }
      fila.getCell("referencias").alignment = { wrapText: true, vertical: "top" };
      // El CP como texto: Excel se come el cero inicial de los CP que
      // empiezan con 0 y deja de cuadrar con el catalogo.
      fila.getCell("cp").numFmt = "@";
      // Una venta que no llego a la mensajeria se tiene que ver de lejos.
      if (v && v.fullvectorSyncStatus !== "SYNCED") {
        fila.getCell("entrega").font = { bold: true, color: { argb: "FFC0392B" } };
      }
    }

    const encabezado = sheet.getRow(1);
    encabezado.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    encabezado.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7E5A97" } };
    encabezado.alignment = { vertical: "middle", horizontal: "left" };
    encabezado.height = 22;

    // Zebra: con 20+ columnas, seguir un renglon con la vista se vuelve dificil.
    for (let i = 2; i <= sheet.rowCount; i++) {
      if (i % 2 === 0) {
        sheet.getRow(i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF6F4F8" } };
      }
    }

    sheet.autoFilter = { from: "A1", to: { row: 1, column: sheet.columns.length } };

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="historial.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/coordinador/leads/:id/reactivar
//
// Regresa a la cola de asignacion un lead descartado. Hasta ahora un
// DESCARTADO era callejon sin salida: /api/leads/:id/devolver lo rechaza a
// proposito (no es trabajo pendiente de nadie) y la cola solo mira los leads
// sin vendedora, asi que un descarte por error se perdia para siempre.
router.post("/leads/:id/reactivar", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const motivo = typeof req.body?.motivo === "string" ? req.body.motivo.trim().slice(0, 300) : "";

    const lead = await prisma.lead.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });
    if (lead.status === "VENTA") {
      return res.status(409).json({ error: "Este lead ya tiene una venta cerrada" });
    }
    if (lead.status !== "DESCARTADO") {
      return res.status(409).json({ error: "Este lead no esta descartado" });
    }

    const actualizado = await prisma.lead.update({
      where: { id },
      data: {
        status: "NUEVO",
        vendedorId: null,
        asignadoPorCoordinador: false,
        devueltoAt: new Date(),
        devueltoMotivo: motivo || "Descartado por error, reactivado para volver a llamar",
        devueltoPorNombre: req.user.nombre,
      },
    });

    detallarMovimiento(req, {
      entidadId: id,
      descripcion: `Reactivo el lead descartado ${lead.nombre}`,
      antes: { status: "DESCARTADO", vendedor: lead.vendedorId },
      despues: { status: "NUEVO", vendedor: "sin asignar", motivo: actualizado.devueltoMotivo },
    });

    res.json({ message: "Lead regresado a la cola de asignacion", leadId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/coordinador/comisiones?fecha=YYYY-MM-DD
//
// Corte de comisiones de la quincena que contiene `fecha` (hoy si no se
// manda): por vendedora, piezas acumuladas y bloques pagados; y la tarifa
// por venta de cada coordinadora. Es la vista con la que se arma la nomina.
router.get("/comisiones", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const fecha = req.query.fecha ? new Date(`${req.query.fecha}T12:00:00`) : new Date();
    if (Number.isNaN(fecha.getTime())) return res.status(400).json({ error: "fecha invalida" });

    const params = await getParametros(tenantId);
    const vendedoras = await prisma.user.findMany({
      where: { tenantId, rol: "VENDEDOR" },
      select: { id: true, nombre: true, activo: true },
      orderBy: { nombre: "asc" },
    });

    const porVendedora = [];
    for (const v of vendedoras) {
      const q = await calcularQuincenaVendedora(tenantId, v.id, fecha, params);
      // Una vendedora sin movimiento en la quincena no ensucia el corte.
      if (q.ventas.length === 0) continue;
      porVendedora.push({
        id: v.id,
        nombre: v.nombre,
        activo: v.activo,
        piezas: q.piezas,
        bloques: q.bloques,
        sobrantes: q.sobrantes,
        comision: q.comision,
        piezasSinConfirmar: q.ventas.filter((d) => !d.cuenta).reduce((s, d) => s + d.piezas, 0),
        ventas: q.ventas,
      });
    }

    const coordinacion = await calcularQuincenaCoordinadoras(tenantId, fecha, params);

    res.json({
      quincena: coordinacion.quincena,
      reglas: {
        porBloque: params.comisionBloquePiezas,
        importeBloque: params.comisionBloqueMonto,
        tarifaCoordinadora: params.comisionCoordinadoraPorVenta,
        metaDiariaUnidades: params.metaDiariaUnidades,
      },
      vendedoras: porVendedora.sort((a, b) => b.comision - a.comision || b.piezas - a.piezas),
      totalVendedoras: porVendedora.reduce((s, v) => s + v.comision, 0),
      coordinacion,
      totalGeneral: porVendedora.reduce((s, v) => s + v.comision, 0) + coordinacion.total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
