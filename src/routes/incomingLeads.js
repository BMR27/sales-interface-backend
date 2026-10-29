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
      } else if (estado === "DESCARTADO") {
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
