// Consulta del payload crudo con el que llegan los leads por API.
//
// `IncomingLead.rawPayload` guarda el JSON tal como lo mandó el proveedor,
// incluidos los campos que la integración no procesa (ver REQUIRED_FIELDS y
// el destructuring en routes/external.js: ahí se leen folio, phone, product
// y unos pocos más; todo lo demás se conserva pero nadie lo mira).
//
// Eso vuelve imposible responder preguntas como "¿de qué equipo vienen
// estos leads?" o "¿en qué campo mandan el team id?" sin entrar a la base.
// Estas dos rutas lo resuelven sin tocar la ingesta: son de solo lectura y
// no modifican nada del flujo actual.
const express = require("express");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");
const { rangoFechas } = require("../lib/fechasLocales");
const ExcelJS = require("exceljs");
const { LEAD_STATUS_LABELS } = require("../lib/leadStatus");
const { POR_CLAVE: MOTIVO_POR_CLAVE, motivoLabel } = require("../lib/motivosDescarte");
const {
  MORADO, VERDE, ROJO, FMT_DINERO, FMT_FECHA, FMT_PCT,
  rematar, formato, envolver, si, colorEstatus,
} = require("../lib/excelEstilo");

const router = express.Router();
const prisma = require("../lib/prisma");

router.use(authMiddleware, adminMiddleware);


// GET /api/admin/incoming-leads/campos — qué campos manda realmente cada
// proveedor, con cuántas veces aparece cada uno.
//
// Es la ruta que contesta "¿en qué campo viene el team id?": en vez de
// adivinar, muestra las claves que de verdad llegan en el payload.
router.get("/campos", async (req, res) => {
  try {
    const fechas = rangoFechas(req.query.desde, req.query.hasta);

    const filas = await prisma.incomingLead.findMany({
      where: { tenantId: req.user.tenantId, ...(fechas ? { createdAt: fechas } : {}) },
      select: { rawPayload: true },
      orderBy: { createdAt: "desc" },
      // Un muestreo basta para saber qué claves manda el proveedor; recorrer
      // meses de payloads para listar nombres de campo sería desperdicio.
      take: Math.min(Number(req.query.muestra) || 500, 2000),
    });

    const cuenta = new Map();
    for (const f of filas) {
      const p = f.rawPayload;
      if (!p || typeof p !== "object" || Array.isArray(p)) continue;
      for (const clave of Object.keys(p)) {
        cuenta.set(clave, (cuenta.get(clave) || 0) + 1);
      }
    }

    // Los campos que la ingesta sí procesa (routes/external.js). Marcarlos
    // deja ver de un vistazo qué está llegando y nadie está leyendo.
    const PROCESADOS = new Set([
      "folio", "consumerName", "phone", "country", "state", "zipCode",
      "category", "product", "internalSku", "externalSku",
      "firstName", "lastName", "age", "city", "ip",
      // Las dos grafias que acepta la ingesta para el identificador de
      // comprador. Sin esto se seguirian reportando como "llega pero nadie
      // lo lee", que dejo de ser cierto.
      "buyerId", "buyer_id",
    ]);

    res.json({
      analizados: filas.length,
      campos: [...cuenta.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([clave, veces]) => ({
          clave,
          veces,
          procesado: PROCESADOS.has(clave),
        })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/incoming-leads/por-buyer?desde=...&hasta=...
//
// Que tal se porta cada comprador que manda leads. El buyerId lo pone el
// proveedor en el payload (ver routes/external.js); aqui solo se agrupa por
// el y se mira en que termino cada lead.
//
// Los leads que llegaron sin buyerId se reportan juntos en una fila aparte
// en vez de omitirse: si el proveedor todavia no manda el campo, esa fila
// es el reporte entero, y esconderla haria parecer que no llego nada.
router.get("/por-buyer", async (req, res) => {
  try {
    const fechas = rangoFechas(req.query.desde, req.query.hasta);

    const filas = await prisma.incomingLead.findMany({
      where: { tenantId: req.user.tenantId, ...(fechas ? { createdAt: fechas } : {}) },
      select: {
        buyerId: true,
        status: true,
        createdAt: true,
        apiKey: { select: { label: true } },
        assignedLead: {
          select: { status: true, venta: { select: { monto: true } } },
        },
      },
    });

    const porBuyer = new Map();

    for (const fila of filas) {
      // null y "" son lo mismo aqui: un lead que llego sin identificar.
      const clave = fila.buyerId || "";
      if (!porBuyer.has(clave)) {
        porBuyer.set(clave, {
          buyerId: fila.buyerId || null,
          enviados: 0,
          asignados: 0,
          noAsignados: 0,
          vendidos: 0,
          descartados: 0,
          pendientes: 0,
          monto: 0,
          // De que API keys vino. Un mismo comprador puede entrar por mas de
          // una si el proveedor rota credenciales.
          origenes: new Set(),
          primero: fila.createdAt,
          ultimo: fila.createdAt,
        });
      }

      const b = porBuyer.get(clave);
      b.enviados += 1;
      if (fila.apiKey?.label) b.origenes.add(fila.apiKey.label);
      if (fila.createdAt < b.primero) b.primero = fila.createdAt;
      if (fila.createdAt > b.ultimo) b.ultimo = fila.createdAt;

      // "No asignado" es del lado de la ingesta (nunca entro a la
      // operacion); lo demas depende de en que termino el lead.
      if (fila.status === "FAILED" || !fila.assignedLead) {
        if (fila.status === "FAILED") b.noAsignados += 1;
        else b.pendientes += 1;
        continue;
      }

      b.asignados += 1;
      const estado = fila.assignedLead.status;
      if (estado === "VENTA") {
        b.vendidos += 1;
        b.monto += fila.assignedLead.venta?.monto ?? 0;
      } else if (estado === "DESCARTADO" || estado === "NO_CONCRETADO") {
        // Los dos cierres sin venta cuentan juntos aqui: para el proveedor
        // la pregunta es cuantos de sus leads no llegaron a venta.
        b.descartados += 1;
      } else {
        b.pendientes += 1;
      }
    }

    const buyers = [...porBuyer.values()]
      .map((b) => ({
        ...b,
        origenes: [...b.origenes],
        // Sobre lo enviado, no sobre lo asignado: lo que no se pudo
        // trabajar tambien dice algo de la calidad de lo que mandaron.
        conversion: b.enviados > 0 ? Math.round((b.vendidos / b.enviados) * 100) : 0,
      }))
      .sort((a, b) => b.vendidos - a.vendidos || b.enviados - a.enviados);

    res.json({
      total: filas.length,
      // Lo que permite decirle a la pantalla "todavia no te mandan el
      // campo" en vez de mostrar un reporte de una sola fila sin explicar.
      conBuyerId: filas.filter((f) => f.buyerId).length,
      buyers,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});


// GET /api/admin/incoming-leads/por-buyer/export?desde=&hasta=&buyerId=
//
// El mismo corte que la pantalla, en Excel y con lo que ahí no cabe.
//
// Cuatro hojas, en el orden en que se usan al sentarse a revisar con el
// proveedor:
//
//   Resumen        el periodo en una página, con cada cifra definida
//   Por comprador  la tabla de la pantalla, más fechas, orígenes y ticket
//   Motivos        POR QUÉ se cayeron los leads de cada comprador. Es la
//                  hoja que convierte el reporte en un reclamo: no es lo
//                  mismo que un comprador falle por números inexistentes
//                  que porque sus clientes no quisieron comprar
//   Detalle        un renglón por lead, para auditar cualquier cifra
router.get("/por-buyer/export", async (req, res) => {
  try {
    const fechas = rangoFechas(req.query.desde, req.query.hasta);

    // Filtro por comprador. Tres casos, y el tercero importa:
    //
    //   sin parametro   todos los compradores
    //   "4195"          solo ese
    //   "SIN_ID"        los que llegaron SIN buyerId, que hoy son la
    //                   mitad de lo recibido y no se podian aislar --
    //                   justo el grupo del que mas hay que hablar con el
    //                   proveedor.
    //
    // Se usa un centinela y no una cadena vacia porque `?buyerId=` vacio
    // y "no mandes el parametro" son indistinguibles en una query.
    const buyerPedido = typeof req.query.buyerId === "string" ? req.query.buyerId.trim() : "";
    const filtroBuyer = !buyerPedido
      ? {}
      : buyerPedido === "SIN_ID"
        ? { OR: [{ buyerId: null }, { buyerId: "" }] }
        : { buyerId: buyerPedido };

    const filas = await prisma.incomingLead.findMany({
      where: {
        tenantId: req.user.tenantId,
        ...(fechas ? { createdAt: fechas } : {}),
        ...filtroBuyer,
      },
      orderBy: { createdAt: "asc" },
      select: {
        buyerId: true, folio: true, consumerName: true, phone: true, product: true,
        status: true, errorMessage: true, createdAt: true,
        apiKey: { select: { label: true } },
        assignedLead: {
          select: {
            folioPS: true, status: true, motivoDescarte: true, motivoDescarteNota: true,
            state: true, createdAt: true,
            vendedor: { select: { nombre: true } },
            venta: { select: { monto: true, cancelada: true, entregaExitosa: true } },
            _count: { select: { llamadas: true } },
          },
        },
      },
    });

    // --- Agregado por comprador ---
    const porBuyer = new Map();
    const motivosPorBuyer = new Map();

    for (const f of filas) {
      const clave = f.buyerId || "";
      if (!porBuyer.has(clave)) {
        porBuyer.set(clave, {
          buyerId: f.buyerId || null,
          enviados: 0, noAsignados: 0, pendientes: 0, vendidos: 0, descartados: 0,
          monto: 0, llamadas: 0,
          origenes: new Set(), primero: f.createdAt, ultimo: f.createdAt,
        });
        motivosPorBuyer.set(clave, new Map());
      }
      const b = porBuyer.get(clave);
      b.enviados += 1;
      if (f.apiKey?.label) b.origenes.add(f.apiKey.label);
      if (f.createdAt < b.primero) b.primero = f.createdAt;
      if (f.createdAt > b.ultimo) b.ultimo = f.createdAt;

      const l = f.assignedLead;
      if (f.status === "FAILED" || !l) {
        if (f.status === "FAILED") b.noAsignados += 1;
        else b.pendientes += 1;
        continue;
      }
      b.llamadas += l._count?.llamadas ?? 0;

      if (l.status === "VENTA") {
        b.vendidos += 1;
        if (l.venta && !l.venta.cancelada) b.monto += l.venta.monto;
      } else if (l.status === "DESCARTADO" || l.status === "NO_CONCRETADO") {
        b.descartados += 1;
        const clv = l.motivoDescarte || "(sin motivo)";
        const m = motivosPorBuyer.get(clave);
        m.set(clv, (m.get(clv) || 0) + 1);
      } else {
        b.pendientes += 1;
      }
    }

    const buyers = [...porBuyer.entries()]
      .map(([clave, b]) => ({
        clave,
        ...b,
        origenes: [...b.origenes],
        conversion: b.enviados > 0 ? b.vendidos / b.enviados : 0,
        ticket: b.vendidos > 0 ? b.monto / b.vendidos : 0,
      }))
      .sort((a, b) => b.vendidos - a.vendidos || b.enviados - a.enviados);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Perfect Sales";
    wb.created = new Date();

    // ---------------- Hoja 1: Resumen ----------------
    const resumen = wb.addWorksheet("Resumen");
    resumen.columns = [
      { header: "Indicador", key: "k", width: 40 },
      { header: "Valor", key: "v", width: 18 },
      { header: "Cómo se mide", key: "n", width: 76 },
    ];
    const totalEnviados = filas.length;
    const conBuyer = filas.filter((f) => f.buyerId).length;
    const totVendidos = buyers.reduce((s, b) => s + b.vendidos, 0);
    const totDescartados = buyers.reduce((s, b) => s + b.descartados, 0);
    const totMonto = buyers.reduce((s, b) => s + b.monto, 0);
    const identificados = buyers.filter((b) => b.buyerId);

    const R = [];
    const add = (k, v, n, o = {}) => R.push({ k, v, n, ...o });
    add("Periodo", fechas ? `${req.query.desde || "inicio"} al ${req.query.hasta || "hoy"}` : "Todo el histórico",
      "Por fecha de recepción del lead.");
    // Si el reporte está filtrado hay que decirlo arriba: sin esta línea,
    // un archivo de un solo comprador se lee como si fuera el total del
    // periodo y las cifras se citan mal.
    if (buyerPedido) {
      add(
        "Filtrado por comprador",
        buyerPedido === "SIN_ID" ? "Solo los que llegaron sin buyerId" : buyerPedido,
        "Este archivo NO incluye al resto de los compradores del periodo."
      );
    }
    add("", "", "");
    add("LO QUE LLEGÓ", "", "", { seccion: true });
    add("Envíos recibidos", totalEnviados, "Registros que entraron por la API en el periodo.");
    add("Traen buyerId", conBuyer, "Los que el proveedor identificó. Sin este campo no se puede saber de qué comprador vino el lead.");
    add("Sin identificar", totalEnviados - conBuyer,
      "Llegaron sin buyerId. Se agrupan en una sola fila: no son de un comprador, son de ninguno.",
      { alerta: totalEnviados - conBuyer > 0 });
    add("Compradores identificados", identificados.length, "Cuántos buyerId distintos mandaron al menos un lead.");
    add("", "", "");
    add("EN QUÉ TERMINÓ", "", "", { seccion: true });
    add("Vendidos", totVendidos, "Leads que terminaron en venta.");
    add("Conversión global", totalEnviados ? totVendidos / totalEnviados : 0,
      "Vendidos entre TODO lo enviado, no entre lo asignado: lo que no se pudo trabajar también dice algo de lo que mandaron.", { pct: true });
    add("Caídos", totDescartados, "Cerrados sin venta, por descarte o por agotarse el protocolo.");
    add("Monto vendido", totMonto, "Producto, sin envío, de las ventas no canceladas.", { dinero: true });
    add("Ticket promedio", totVendidos ? totMonto / totVendidos : 0, "Monto entre leads vendidos.", { dinero: true });
    add("", "", "");
    add("QUIÉN DESTACA", "", "", { seccion: true });
    const mejor = identificados.filter((b) => b.enviados >= 10).sort((a, b) => b.conversion - a.conversion)[0];
    const peor = identificados.filter((b) => b.enviados >= 10).sort((a, b) => a.conversion - b.conversion)[0];
    add("Mejor comprador", mejor ? `${mejor.buyerId} — ${(mejor.conversion * 100).toFixed(1)}%` : "—",
      "Mayor conversión entre los que mandaron 10 o más leads. Con menos, el porcentaje no dice nada.");
    add("Peor comprador", peor ? `${peor.buyerId} — ${(peor.conversion * 100).toFixed(1)}%` : "—",
      "Menor conversión con el mismo mínimo de 10 leads.");

    for (const f of R) {
      const fila = resumen.addRow({ k: f.k, v: f.v, n: f.n });
      if (f.seccion) fila.getCell("k").font = { bold: true, color: { argb: MORADO }, size: 11 };
      if (f.dinero) fila.getCell("v").numFmt = FMT_DINERO;
      if (f.pct) fila.getCell("v").numFmt = FMT_PCT;
      if (f.alerta) fila.getCell("v").font = { bold: true, color: { argb: ROJO } };
      envolver(fila, ["n"]);
    }
    rematar(resumen, { zebra: false, filtro: false });

    // ---------------- Hoja 2: Por comprador ----------------
    const hoja = wb.addWorksheet("Por comprador");
    hoja.columns = [
      { header: "Comprador (buyerId)", key: "buyer", width: 26 },
      { header: "Origen", key: "origen", width: 34 },
      { header: "Enviados", key: "enviados", width: 11 },
      { header: "No entraron", key: "noAsignados", width: 13 },
      { header: "Abiertos", key: "pendientes", width: 11 },
      { header: "Caídos", key: "descartados", width: 10 },
      { header: "Vendidos", key: "vendidos", width: 11 },
      { header: "Conversión", key: "conversion", width: 12 },
      { header: "Monto vendido", key: "monto", width: 15 },
      { header: "Ticket promedio", key: "ticket", width: 15 },
      { header: "Llamadas", key: "llamadas", width: 11 },
      { header: "Llamadas por venta", key: "porVenta", width: 17 },
      { header: "Primer envío", key: "primero", width: 17 },
      { header: "Último envío", key: "ultimo", width: 17 },
    ];

    for (const b of buyers) {
      const fila = hoja.addRow({
        buyer: b.buyerId || "Sin identificar",
        origen: b.origenes.join(", "),
        enviados: b.enviados,
        noAsignados: b.noAsignados,
        pendientes: b.pendientes,
        descartados: b.descartados,
        vendidos: b.vendidos,
        conversion: b.conversion,
        monto: b.monto,
        ticket: b.ticket,
        llamadas: b.llamadas,
        porVenta: b.vendidos > 0 ? Math.round((b.llamadas / b.vendidos) * 10) / 10 : "",
        primero: b.primero,
        ultimo: b.ultimo,
      });
      fila.getCell("conversion").numFmt = FMT_PCT;
      formato(fila, ["monto", "ticket"], FMT_DINERO);
      formato(fila, ["primero", "ultimo"], FMT_FECHA);
      if (!b.buyerId) fila.getCell("buyer").font = { italic: true, color: { argb: "FF6B7280" } };
      if (b.vendidos > 0) fila.getCell("vendidos").font = { bold: true, color: { argb: VERDE } };
      if (b.noAsignados > 0) fila.getCell("noAsignados").font = { bold: true, color: { argb: ROJO } };
    }

    const tot = hoja.addRow({
      buyer: "TOTAL",
      enviados: totalEnviados,
      noAsignados: buyers.reduce((s, b) => s + b.noAsignados, 0),
      pendientes: buyers.reduce((s, b) => s + b.pendientes, 0),
      descartados: totDescartados,
      vendidos: totVendidos,
      conversion: totalEnviados ? totVendidos / totalEnviados : 0,
      monto: totMonto,
      ticket: totVendidos ? totMonto / totVendidos : 0,
      llamadas: buyers.reduce((s, b) => s + b.llamadas, 0),
    });
    tot.font = { bold: true };
    tot.getCell("conversion").numFmt = FMT_PCT;
    formato(tot, ["monto", "ticket"], FMT_DINERO);
    rematar(hoja);

    // ---------------- Hoja 3: Motivos por comprador ----------------
    const mot = wb.addWorksheet("Motivos por comprador");
    mot.columns = [
      { header: "Comprador (buyerId)", key: "buyer", width: 26 },
      { header: "Motivo de caída", key: "motivo", width: 34 },
      { header: "Clave", key: "clave", width: 22 },
      { header: "Leads", key: "total", width: 9 },
      { header: "% de sus caídas", key: "pct", width: 15 },
      { header: "¿Culpa del proveedor?", key: "culpa", width: 20 },
      { header: "Qué significa", key: "ayuda", width: 60 },
    ];

    for (const b of buyers) {
      const m = motivosPorBuyer.get(b.clave);
      if (!m || m.size === 0) continue;
      const total = [...m.values()].reduce((s, n) => s + n, 0);
      for (const [clave, n] of [...m.entries()].sort((a, b2) => b2[1] - a[1])) {
        const def = MOTIVO_POR_CLAVE[clave];
        const fila = mot.addRow({
          buyer: b.buyerId || "Sin identificar",
          motivo: clave === "(sin motivo)" ? "Sin motivo capturado" : motivoLabel(clave),
          clave,
          total: n,
          pct: total ? n / total : 0,
          culpa: def ? si(def.culpaDelProveedor) : "",
          ayuda: def?.ayuda || "",
        });
        fila.getCell("pct").numFmt = FMT_PCT;
        envolver(fila, ["ayuda"]);
        if (def?.culpaDelProveedor) fila.getCell("culpa").font = { bold: true, color: { argb: ROJO } };
      }
    }
    if (mot.rowCount === 1) mot.addRow({ buyer: "Ningún lead del periodo se ha caído todavía." });
    rematar(mot);

    // ---------------- Hoja 4: Detalle ----------------
    const det = wb.addWorksheet("Detalle");
    det.columns = [
      { header: "Comprador (buyerId)", key: "buyer", width: 24 },
      { header: "Folio proveedor", key: "folio", width: 16 },
      { header: "Folio PS", key: "folioPS", width: 13 },
      { header: "Recibido", key: "recibido", width: 17 },
      { header: "Origen", key: "origen", width: 30 },
      { header: "¿Entró?", key: "entro", width: 10 },
      { header: "Por qué no entró", key: "error", width: 34 },
      { header: "Estatus", key: "estatus", width: 16 },
      { header: "Motivo de caída", key: "motivo", width: 28 },
      { header: "Nota del motivo", key: "nota", width: 34 },
      { header: "Vendedora", key: "vendedora", width: 20 },
      { header: "Llamadas", key: "llamadas", width: 10 },
      { header: "Cliente", key: "cliente", width: 24 },
      { header: "Producto", key: "producto", width: 22 },
      { header: "Estado", key: "estado", width: 18 },
      { header: "Monto", key: "monto", width: 13 },
    ];

    for (const f of filas) {
      const l = f.assignedLead;
      const fila = det.addRow({
        buyer: f.buyerId || "Sin identificar",
        folio: f.folio,
        folioPS: l?.folioPS || "",
        recibido: f.createdAt,
        origen: f.apiKey?.label || "",
        entro: l ? "Sí" : "No",
        error: f.errorMessage || "",
        estatus: l ? LEAD_STATUS_LABELS[l.status] || l.status : `No ingresó (${f.status})`,
        motivo: l?.motivoDescarte ? motivoLabel(l.motivoDescarte) : "",
        nota: l?.motivoDescarteNota || "",
        vendedora: l?.vendedor?.nombre || "",
        llamadas: l ? l._count?.llamadas ?? 0 : "",
        cliente: f.consumerName,
        producto: f.product,
        estado: l?.state || "",
        monto: l?.venta && !l.venta.cancelada ? l.venta.monto : "",
      });
      fila.getCell("recibido").numFmt = FMT_FECHA;
      fila.getCell("monto").numFmt = FMT_DINERO;
      envolver(fila, ["error", "nota"]);
      if (l) fila.getCell("estatus").font = { bold: true, color: { argb: colorEstatus(l.status) } };
      else fila.getCell("entro").font = { bold: true, color: { argb: ROJO } };
    }
    rematar(det);

    const quien = buyerPedido ? `_${buyerPedido.replace(/[^\w.-]/g, "")}` : "";
    const nombre = `por_comprador${quien}_${req.query.desde || "inicio"}_a_${req.query.hasta || "hoy"}.xlsx`;
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${nombre}"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/incoming-leads?q=2671&desde=...&hasta=...
//
// `q` busca en TODO el payload, no en un campo concreto: cuando un proveedor
// pregunta por un id suyo no se sabe de antemano bajo qué nombre lo manda.
router.get("/", async (req, res) => {
  try {
    const { q, status } = req.query;
    const take = Math.min(Number(req.query.limite) || 50, 200);
    const skip = Number(req.query.offset) || 0;
    const fechas = rangoFechas(req.query.desde, req.query.hasta);

    const where = {
      tenantId: req.user.tenantId,
      ...(fechas ? { createdAt: fechas } : {}),
      ...(status ? { status } : {}),
    };

    const [filas, total] = await Promise.all([
      prisma.incomingLead.findMany({
        where,
        orderBy: { createdAt: "desc" },
        // Con búsqueda se trae un bloque más grande y se filtra abajo: el
        // "contiene" sobre JSON no se puede expresar en el where de Prisma
        // sin SQL crudo, y no vale la pena meter SQL a mano por esto.
        take: q ? Math.min(take * 20, 2000) : take,
        skip: q ? 0 : skip,
        include: {
          apiKey: { select: { id: true, label: true, keyPrefix: true } },
          assignedLead: { select: { id: true, status: true, vendedor: { select: { nombre: true } } } },
        },
      }),
      prisma.incomingLead.count({ where }),
    ]);

    const aguja = q ? String(q).toLowerCase() : null;
    const coincide = (fila) =>
      !aguja || JSON.stringify(fila.rawPayload ?? {}).toLowerCase().includes(aguja);

    const encontrados = filas.filter(coincide);

    res.json({
      // Con búsqueda, `total` es el universo revisado, no las coincidencias:
      // decirlo evita leer 4 resultados de 900 como "4 de 4".
      total: aguja ? encontrados.length : total,
      revisados: aguja ? filas.length : undefined,
      items: encontrados.slice(0, take).map((f) => ({
        id: f.id,
        folio: f.folio,
        cliente: f.consumerName,
        telefono: f.phone,
        producto: f.product,
        status: f.status,
        errorMessage: f.errorMessage,
        createdAt: f.createdAt,
        apiKey: f.apiKey,
        lead: f.assignedLead,
        rawPayload: f.rawPayload,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
