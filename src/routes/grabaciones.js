// Grabaciones de llamadas, para monitoreo del administrador.
//
// El audio vive en Twilio y se sirve por proxy: nunca se le entrega al
// navegador una URL de Twilio ni las credenciales que la abren. Eso es lo
// que permite exigir rol ADMIN en cada reproducción y dejar constancia en
// el kardex de quién escuchó qué -- una grabación de una llamada es un dato
// sensible y quien la oye tiene que quedar registrado.
const express = require("express");
const { Readable } = require("stream");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");
const { registrar } = require("../lib/auditoria");
const { rangoFechas } = require("../lib/fechasLocales");

const router = express.Router();
const prisma = require("../lib/prisma");

router.use(authMiddleware, adminMiddleware);

function credencialesTwilio() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return { sid, basic: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") };
}

// GET /api/admin/grabaciones — listado con filtros
router.get("/", async (req, res) => {
  try {
    const { vendedorId, leadId, desde, hasta, q } = req.query;
    const where = { tenantId: req.user.tenantId };

    if (vendedorId) where.vendedorId = Number(vendedorId);
    if (leadId) where.leadId = Number(leadId);

    // Los límites del rango se calculan en la hora de la operación, no en la
    // del servidor (ver src/lib/fechasLocales.js).
    const fechas = rangoFechas(desde, hasta);
    if (fechas) where.createdAt = fechas;

    // Búsqueda por teléfono o por nombre del cliente. El teléfono se guarda
    // en E.164 (+52...), así que se comparan sólo los dígitos: quien busca
    // "6421047861" tiene que encontrar "+526421047861".
    if (q) {
      const texto = String(q).trim();
      const digitos = texto.replace(/\D/g, "");
      const condiciones = [{ nombre: { contains: texto, mode: "insensitive" } }];
      if (digitos.length >= 4) condiciones.push({ telefono: { contains: digitos } });
      where.lead = { OR: condiciones };
    }

    const limite = Math.min(Number(req.query.limite) || 50, 200);
    const [items, total] = await Promise.all([
      prisma.grabacionLlamada.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limite,
        skip: Number(req.query.offset) || 0,
        include: {
          vendedor: { select: { id: true, nombre: true } },
          lead: { select: { id: true, nombre: true, telefono: true, producto: true, status: true } },
        },
      }),
      prisma.grabacionLlamada.count({ where }),
    ]);

    res.json({
      total,
      items: items.map((g) => ({
        id: g.id,
        estado: g.estado,
        duracion: g.duracion,
        fecha: g.createdAt,
        grabadaAt: g.grabadaAt,
        // El RecordingSid no se expone: no le sirve de nada al navegador y
        // es la llave con la que se pediría el audio directo a Twilio.
        reproducible: g.estado === "COMPLETADA" && !!g.recordingSid,
        vendedor: g.vendedor,
        lead: g.lead,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/grabaciones/:id/audio — reproduce el audio.
//
// Soporta Range porque el <audio> del navegador lo usa para poder adelantar
// sin descargar todo; sin eso la barra de avance no funciona.
router.get("/:id/audio", async (req, res) => {
  try {
    const grabacion = await prisma.grabacionLlamada.findFirst({
      where: { id: Number(req.params.id), tenantId: req.user.tenantId },
      include: { lead: { select: { nombre: true } }, vendedor: { select: { nombre: true } } },
    });
    if (!grabacion) return res.status(404).json({ error: "Grabación no encontrada" });
    if (grabacion.estado !== "COMPLETADA" || !grabacion.recordingSid) {
      return res.status(409).json({ error: "Esta llamada no tiene audio guardado" });
    }

    const cred = credencialesTwilio();
    if (!cred) {
      return res.status(503).json({ error: "Twilio no está configurado en el servidor" });
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${cred.sid}/Recordings/${grabacion.recordingSid}.mp3`;
    const upstream = await fetch(url, {
      headers: {
        Authorization: cred.basic,
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
    });

    if (!upstream.ok && upstream.status !== 206) {
      console.error("Twilio devolvió", upstream.status, "al pedir la grabación", grabacion.recordingSid);
      return res.status(502).json({ error: "No se pudo obtener el audio de Twilio" });
    }

    // Escuchar una llamada es un acceso a dato sensible: queda en el kardex.
    // El middleware global sólo audita escrituras, así que se registra aquí.
    // Sin await: la bitácora no debe retrasar la reproducción.
    registrar({
      tenantId: req.user.tenantId,
      userId: req.user.id,
      userNombre: req.user.nombre,
      userEmail: req.user.email,
      userRol: req.user.rol,
      accion: "grabacion.reproducida",
      entidad: "Grabación",
      entidadId: grabacion.id,
      descripcion: `${req.user.nombre} escuchó la llamada de ${grabacion.vendedor?.nombre || "vendedora desconocida"} con ${grabacion.lead?.nombre || "cliente desconocido"}`,
      metodo: "GET",
      ruta: req.originalUrl,
      statusCode: 200,
      ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.status(upstream.status === 206 ? 206 : 200);
    res.set("Content-Type", "audio/mpeg");
    res.set("Accept-Ranges", "bytes");
    for (const cabecera of ["content-length", "content-range"]) {
      const valor = upstream.headers.get(cabecera);
      if (valor) res.set(cabecera, valor);
    }
    // Un audio de una llamada no se guarda en caches intermedias.
    res.set("Cache-Control", "private, no-store");

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Error del servidor" });
  }
});

// DELETE /api/admin/grabaciones/:id — borra el audio en Twilio y deja la
// fila como constancia de que existió y se eliminó. Hace falta tanto para
// atender una solicitud de supresión del cliente como para no pagar
// almacenamiento de audio que ya no se va a escuchar.
router.delete("/:id", async (req, res) => {
  try {
    const grabacion = await prisma.grabacionLlamada.findFirst({
      where: { id: Number(req.params.id), tenantId: req.user.tenantId },
    });
    if (!grabacion) return res.status(404).json({ error: "Grabación no encontrada" });

    if (grabacion.recordingSid) {
      const cred = credencialesTwilio();
      if (!cred) return res.status(503).json({ error: "Twilio no está configurado en el servidor" });

      const r = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${cred.sid}/Recordings/${grabacion.recordingSid}.json`,
        { method: "DELETE", headers: { Authorization: cred.basic } },
      );
      // 404 es aceptable: si ya no está en Twilio, el objetivo se cumplió.
      if (!r.ok && r.status !== 404) {
        return res.status(502).json({ error: "No se pudo borrar el audio en Twilio" });
      }
    }

    await prisma.grabacionLlamada.update({
      where: { id: grabacion.id },
      data: { estado: "BORRADA", recordingSid: null, error: null },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
