// Gestión de las ventas que FullVector aceptó fuera de su cobertura
// (trackingStatus NO_COVERAGE). En esos códigos postales la mensajería no
// cobra en efectivo contra entrega, así que la venta no se puede dar por
// cerrada al confirmarla: hay que llamar al cliente, ofrecerle pago por
// transferencia y, cuando el dinero cae, mandar el paquete por mensajería
// tradicional. Este módulo es el expediente de ese seguimiento.
//
// Lo ven ADMIN y COORDINADOR: la coordinadora es quien hace las llamadas y
// el admin quien vigila el dinero detenido.
const express = require("express");
const authMiddleware = require("../middleware/auth");

const router = express.Router();
const prisma = require("../lib/prisma");

const ESTADOS = ["PENDIENTE_CONTACTO", "TRANSFERENCIA_OFRECIDA", "PAGO_CONFIRMADO", "ENVIADO", "CANCELADO"];

function soloGestores(req, res, next) {
  if (req.user?.rol !== "ADMIN" && req.user?.rol !== "COORDINADOR") {
    return res.status(403).json({ error: "Acceso restringido a administradores y coordinadores" });
  }
  next();
}

router.use(authMiddleware, soloGestores);

const INCLUDE_COMPLETO = {
  notas: { orderBy: { createdAt: "desc" } },
  venta: {
    include: {
      vendedor: { select: { id: true, nombre: true } },
      lead: true,
    },
  },
};

function serializar(g) {
  const v = g.venta;
  const l = v?.lead;
  return {
    id: g.id,
    estado: g.estado,
    pago: {
      referencia: g.pagoReferencia,
      monto: g.pagoMonto,
      confirmadoAt: g.pagoConfirmadoAt,
      confirmadoPor: g.pagoConfirmadoPor,
    },
    envio: {
      paqueteria: g.paqueteria,
      guia: g.guia,
      enviadoAt: g.enviadoAt,
    },
    creadaAt: g.createdAt,
    actualizadaAt: g.updatedAt,
    notas: (g.notas || []).map((n) => ({
      id: n.id, nota: n.nota, autor: n.autorNombre, fecha: n.createdAt,
    })),
    venta: v && {
      id: v.id,
      folio: v.folio,
      fecha: v.fecha,
      monto: v.monto,
      costoEnvio: v.costoEnvio,
      // Lo que hay que cobrarle al cliente por transferencia: producto más
      // flete, igual que el orderValue que se le mandó a FullVector.
      totalACobrar: v.monto + (v.costoEnvio || 0),
      fullvectorOrderId: v.fullvectorOrderId,
      vendedor: v.vendedor,
    },
    cliente: l && {
      leadId: l.id,
      nombre: `${l.nombre} ${l.apellido || ""}`.trim(),
      telefono: l.telefono,
      producto: l.producto,
      cantidad: l.cantidad,
      direccion: {
        calle: l.shippingStreet,
        numero: l.shippingNumber,
        referencias: l.shippingReferences,
        colonia: l.colonia,
        municipio: l.municipio,
        estado: l.state,
        codigoPostal: l.zipCode,
      },
    },
  };
}

// GET /api/prepago?estado=PENDIENTE_CONTACTO&q=texto
router.get("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const estado = ESTADOS.includes(req.query.estado) ? req.query.estado : null;
    const q = String(req.query.q || "").trim();

    const gestiones = await prisma.prepagoGestion.findMany({
      where: {
        tenantId,
        ...(estado ? { estado } : {}),
        ...(q
          ? {
              OR: [
                { venta: { folio: { contains: q, mode: "insensitive" } } },
                { venta: { lead: { nombre: { contains: q, mode: "insensitive" } } } },
                { venta: { lead: { telefono: { contains: q } } } },
                { venta: { lead: { zipCode: { contains: q } } } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      include: INCLUDE_COMPLETO,
    });

    const porEstado = await prisma.prepagoGestion.groupBy({
      by: ["estado"],
      where: { tenantId },
      _count: true,
    });

    const items = gestiones.map(serializar);
    res.json({
      total: items.length,
      // Dinero que todavía no entra: lo pendiente de cobrar por transferencia.
      montoPorCobrar: items
        .filter((g) => g.estado !== "PAGO_CONFIRMADO" && g.estado !== "ENVIADO" && g.estado !== "CANCELADO")
        .reduce((s, g) => s + (g.venta?.totalACobrar || 0), 0),
      porEstado: ESTADOS.reduce(
        (acc, e) => ({ ...acc, [e]: porEstado.find((p) => p.estado === e)?._count || 0 }),
        {},
      ),
      gestiones: items,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// PATCH /api/prepago/:id — estado, datos del cobro y datos del envío externo
router.patch("/:id", async (req, res) => {
  try {
    const gestion = await prisma.prepagoGestion.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!gestion) return res.status(404).json({ error: "Gestión no encontrada" });

    const { estado, pagoReferencia, pagoMonto, paqueteria, guia } = req.body;
    if (estado !== undefined && !ESTADOS.includes(estado)) {
      return res.status(400).json({ error: "estado inválido" });
    }

    const data = {};
    if (estado !== undefined) data.estado = estado;
    if (pagoReferencia !== undefined) data.pagoReferencia = pagoReferencia || null;
    if (pagoMonto !== undefined) data.pagoMonto = pagoMonto === null || pagoMonto === "" ? null : Number(pagoMonto);
    if (paqueteria !== undefined) data.paqueteria = paqueteria || null;
    if (guia !== undefined) data.guia = guia || null;

    // Las fechas no se piden en el formulario: se sellan solas al momento de
    // cambiar de estado, que es cuando de verdad ocurrió la cosa. Sólo se
    // ponen la primera vez, para no mover la fecha al reeditar una referencia.
    if (estado === "PAGO_CONFIRMADO" && !gestion.pagoConfirmadoAt) {
      data.pagoConfirmadoAt = new Date();
      data.pagoConfirmadoPor = req.user.nombre || req.user.email || null;
    }
    if (estado === "ENVIADO" && !gestion.enviadoAt) {
      data.enviadoAt = new Date();
    }

    const actualizada = await prisma.prepagoGestion.update({
      where: { id: gestion.id },
      data,
      include: INCLUDE_COMPLETO,
    });

    res.json(serializar(actualizada));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/prepago/:id/notas — bitácora de contacto
router.post("/:id/notas", async (req, res) => {
  try {
    const nota = String(req.body?.nota || "").trim();
    if (!nota) return res.status(400).json({ error: "La nota no puede ir vacía" });

    const gestion = await prisma.prepagoGestion.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!gestion) return res.status(404).json({ error: "Gestión no encontrada" });

    await prisma.prepagoNota.create({
      data: {
        gestionId: gestion.id,
        nota: nota.slice(0, 1000),
        autorId: req.user.id,
        autorNombre: req.user.nombre || req.user.email || "Sin nombre",
        tenantId: req.user.tenantId,
      },
    });

    const actualizada = await prisma.prepagoGestion.findUnique({
      where: { id: gestion.id },
      include: INCLUDE_COMPLETO,
    });
    res.status(201).json(serializar(actualizada));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// PUT /api/prepago/:id/direccion — corregir el domicilio sin salir de la pantalla
router.put("/:id/direccion", async (req, res) => {
  try {
    const gestion = await prisma.prepagoGestion.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
      include: { venta: { select: { leadId: true } } },
    });
    if (!gestion) return res.status(404).json({ error: "Gestión no encontrada" });

    const { calle, numero, referencias, colonia, municipio, estado, codigoPostal, telefono } = req.body;
    const data = {};
    if (calle !== undefined) data.shippingStreet = calle || null;
    if (numero !== undefined) data.shippingNumber = numero || null;
    if (referencias !== undefined) data.shippingReferences = referencias || null;
    if (colonia !== undefined) data.colonia = colonia || null;
    if (municipio !== undefined) data.municipio = municipio || null;
    if (estado !== undefined) data.state = estado || null;
    if (codigoPostal !== undefined) data.zipCode = codigoPostal || null;
    if (telefono !== undefined && telefono) data.telefono = telefono;

    await prisma.lead.update({ where: { id: gestion.venta.leadId }, data });

    const actualizada = await prisma.prepagoGestion.findUnique({
      where: { id: gestion.id },
      include: INCLUDE_COMPLETO,
    });
    res.json(serializar(actualizada));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/prepago/sincronizar — abre expediente a las ventas que ya estaban
// marcadas sin cobertura antes de que existiera esta pantalla.
router.post("/sincronizar", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const huerfanas = await prisma.venta.findMany({
      where: { tenantId, fullvectorSinCobertura: true, prepago: { is: null } },
      select: { id: true },
    });

    if (huerfanas.length > 0) {
      await prisma.prepagoGestion.createMany({
        data: huerfanas.map((v) => ({ ventaId: v.id, tenantId })),
        skipDuplicates: true,
      });
    }

    res.json({ creadas: huerfanas.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
