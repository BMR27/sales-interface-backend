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
