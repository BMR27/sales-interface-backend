const express = require("express");
const crypto = require("crypto");
const authMiddleware = require("../middleware/auth");
const { requirePermiso } = require("../lib/permisosCatalog");
const { siguienteFolio } = require("../lib/folios");
const { MOTIVOS, parseMotivo, esTrash } = require("../lib/motivosDescarte");
const { isEnabled: smsEnabled, sendSms } = require("../lib/twilioSms");
const { LEAD_STATUSES, LEAD_STATUSES_ABIERTOS, parseLeadStatus } = require("../lib/leadStatus");
const { notificarLeadNuevo } = require("../lib/notificaciones");
const { registrarResultado, historialDeLead } = require("../lib/historialLlamadas");
const { ocultarTelefonoLead, ocultarTelefonoLeads, ocultaTelefono } = require("../lib/telefono");
const { detallarMovimiento } = require("../lib/auditoria");

const router = express.Router();
const prisma = require("../lib/prisma");

// GET /api/leads
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { status, search } = req.query;
    const vendedorId = req.user.id;

    const where = { vendedorId };
    if (status) {
      const parsed = parseLeadStatus(status);
      if (!parsed) {
        return res.status(400).json({ error: `status inválido. Valores: ${LEAD_STATUSES.join(", ")}` });
      }
      where.status = parsed;
    }
    if (search) {
      where.OR = [
        { nombre: { contains: search, mode: "insensitive" } },
        { producto: { contains: search, mode: "insensitive" } },
      ];
    }

    const leads = await prisma.lead.findMany({
      where,
      orderBy: { updatedAt: "desc" },
    });

    const counts = await prisma.lead.groupBy({
      by: ["status"],
      where: { vendedorId },
      _count: true,
    });

    const totalMonto = await prisma.lead.aggregate({
      where: { vendedorId, status: "VENTA" },
      _sum: { monto: true },
    });

    res.json({
      // La vendedora ve los ultimos 4 digitos si el parametro
      // ocultarTelefonoVendedor esta encendido (ver src/lib/telefono.js).
      leads: await ocultarTelefonoLeads(leads, req.user),
      counts: counts.reduce((acc, c) => ({ ...acc, [c.status]: c._count }), {}),
      totalVentas: totalMonto._sum.monto || 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/leads/motivos-descarte — el catalogo, para que la pantalla lo
// dibuje sin tenerlo duplicado del lado del navegador.
//
// Va ANTES de GET /:id a proposito: Express casa por orden de declaracion,
// y declarada despues caeria en el comodin del id.
router.get("/motivos-descarte", authMiddleware, (req, res) => {
  res.json({ motivos: MOTIVOS });
});

// GET /api/leads/:id
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: parseInt(req.params.id), vendedorId: req.user.id },
    });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });
    res.json(await ocultarTelefonoLead(lead, req.user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/leads
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { nombre, apellido, edad, telefono, producto, cantidad, hora, categoria, notas, productoId, country, city, ip } = req.body;
    if (!nombre || !telefono || !producto) {
      return res.status(400).json({ error: "Nombre, teléfono y producto requeridos" });
    }

    const lead = await prisma.lead.create({
      data: {
        nombre, apellido: apellido || null, edad: edad ? Number(edad) : null,
        folioPS: await siguienteFolio(req.user.tenantId),
        telefono, producto, cantidad: cantidad || 1, hora, categoria, notas,
        country: country || null, city: city || null, ip: ip || null,
        productoId: productoId || null,
        vendedorId: req.user.id,
        asignadoAt: new Date(),
        tenantId: req.user.tenantId,
      },
    });
    detallarMovimiento(req, { entidadId: lead.id, descripcion: `Creó el lead ${lead.nombre}`, despues: lead });

    // Sin await: el aviso por correo no debe retrasar la respuesta ni tumbar
    // el alta si el correo falla (ver src/lib/notificaciones.js).
    notificarLeadNuevo(lead, { vendedor: req.user, origen: "web" });

    res.status(201).json(await ocultarTelefonoLead(lead, req.user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// PUT /api/leads/:id
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.lead.findFirst({ where: { id, vendedorId: req.user.id } });
    if (!existing) return res.status(404).json({ error: "Lead no encontrado" });

    const {
      nombre, telefono, producto, cantidad, hora, status, folio, monto, categoria, notas,
      solicitudEspecial,
      shippingStreet, shippingNumber, shippingReferences, zipCode, state, colonia, municipio, lat, lng,
    } = req.body;

    if (status != null && !parseLeadStatus(status)) {
      return res.status(400).json({ error: `status inválido. Valores: ${LEAD_STATUSES.join(", ")}` });
    }

    const lead = await prisma.lead.update({
      where: { id },
      data: {
        nombre, producto, cantidad, hora, status, folio, monto, categoria, notas,
        // Peticiones que no caben en ningun catalogo -- un combo especial,
        // por ejemplo. Solo se toca si viene en el body, para que un PUT
        // de direccion no borre lo que la vendedora ya habia anotado.
        ...(solicitudEspecial !== undefined
          ? { solicitudEspecial: String(solicitudEspecial).trim().slice(0, 500) || null }
          : {}),
        shippingStreet, shippingNumber, shippingReferences, zipCode, state, colonia, municipio, lat, lng,
        // Quien no puede VER el telefono tampoco puede escribirlo. Sin esta
        // guarda, una pantalla que reenviara el valor que recibio grabaria
        // el enmascarado encima del numero real y lo destruiria.
        ...((await ocultaTelefono(req.user)) ? {} : { telefono }),
      },
    });

    // Si la dirección de envío quedó completa y la venta se había marcado
    // FAILED por eso (ver src/lib/fullvector.js), se reintenta sola en vez
    // de dejarla atorada -- quien edite el lead no tiene por qué saber que
    // existe una sincronización con FullVector.
    // La lista es la misma que valida buildOrderPayload: si se reintenta
    // sin todos los campos, el reintento falla igual y solo confunde.
    const direccionCompleta =
      lead.shippingStreet &&
      lead.shippingNumber &&
      lead.colonia &&
      lead.municipio &&
      lead.state &&
      lead.zipCode &&
      lead.telefono;
    if (direccionCompleta) {
      const venta = await prisma.venta.findUnique({ where: { leadId: id } });
      if (venta && venta.fullvectorSyncStatus === "FAILED") {
        await prisma.venta.update({
          where: { id: venta.id },
          data: { fullvectorSyncStatus: "PENDING", fullvectorAttempts: 0, fullvectorError: null },
        });
        require("../lib/fullvector").syncVentaToFullVector(venta.id).catch((err) => {
          console.error("fullvector resync error, venta", venta.id, err);
        });
      }
    }

    detallarMovimiento(req, {
      entidadId: id,
      descripcion: `Editó el lead ${lead.nombre}`,
      antes: existing,
      despues: lead,
    });

    res.json(await ocultarTelefonoLead(lead, req.user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/leads/:id/historial — cuántas veces se ha llamado a este lead,
// quién lo llamó, cuándo y en qué quedó cada intento.
//
// La vendedora solo ve el historial de sus leads; el ADMIN y la coordinadora
// ven el de cualquiera de su empresa, que es lo que necesitan para repartir
// sin repetir el trabajo de otra.
router.get("/:id/historial", authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const puedeVerTodos = ["ADMIN", "COORDINADOR"].includes(req.user.rol);

    const lead = await prisma.lead.findFirst({
      where: {
        id,
        tenantId: req.user.tenantId,
        ...(puedeVerTodos ? {} : { vendedorId: req.user.id }),
      },
      select: { id: true },
    });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });

    res.json(await historialDeLead(id, req.user.tenantId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// DELETE /api/leads/:id (descarta)
router.delete("/:id", authMiddleware, requirePermiso("vendedor.leads.rechazar"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    // El motivo es del catalogo cerrado, no texto libre: de aqui sale el
    // porcentaje de calidad de la base y para medir hace falta un conjunto
    // cerrado (ver src/lib/motivosDescarte.js). La nota es el texto libre
    // que lo acompaña, opcional.
    const motivo = parseMotivo(req.body?.motivo);
    if (req.body?.motivo && !motivo) {
      return res.status(400).json({ error: "Motivo de descarte invalido" });
    }
    const nota = typeof req.body?.nota === "string" ? req.body.nota.trim().slice(0, 300) : null;
    const existing = await prisma.lead.findFirst({ where: { id, vendedorId: req.user.id } });
    if (!existing) return res.status(404).json({ error: "Lead no encontrado" });
    if (existing.status === "VENTA") {
      return res.status(409).json({ error: "Este lead ya tiene una venta cerrada" });
    }

    await prisma.lead.update({
      where: { id },
      data: {
        status: "DESCARTADO",
        motivoDescarte: motivo,
        motivoDescarteNota: nota || null,
        descartadoAt: new Date(),
        descartadoPorId: req.user.id,
      },
    });

    // Descartar es el desenlace de una llamada: sin esto, el historial del
    // lead mostraba el intento pero nunca en qué había terminado.
    await registrarResultado({
      leadId: id,
      vendedorId: req.user.id,
      tenantId: req.user.tenantId,
      resultado: "DESCARTADO",
      estadoAntes: existing.status,
      estadoDespues: "DESCARTADO",
    });

    detallarMovimiento(req, {
      entidadId: id,
      descripcion: `Descartó el lead ${existing.nombre}`,
      antes: { status: existing.status },
      despues: { status: "DESCARTADO" },
    });

    res.json({ message: "Lead descartado" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/leads/:id/supervision — la vendedora no puede atender lo que
// el cliente pidio (quiere que le llamen otro dia, en otro horario, fuera
// de su turno) y lo pasa a la coordinadora, que decide si lo llama ella o
// se lo da a alguien mas.
//
// No es lo mismo que reagendar: reagendar deja el lead con la misma
// vendedora, y aqui justamente el punto es que ella no va a poder.
router.post("/:id/supervision", authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const nota = typeof req.body?.nota === "string" ? req.body.nota.trim().slice(0, 300) : "";
    const fechaReagenda = req.body?.fechaReagenda ? new Date(req.body.fechaReagenda) : null;
    if (fechaReagenda && Number.isNaN(fechaReagenda.getTime())) {
      return res.status(400).json({ error: "Fecha de re-llamada invalida" });
    }

    const existing = await prisma.lead.findFirst({ where: { id, vendedorId: req.user.id } });
    if (!existing) return res.status(404).json({ error: "Lead no encontrado" });
    if (!LEAD_STATUSES_ABIERTOS.includes(existing.status)) {
      return res.status(409).json({
        error:
          existing.status === "VENTA"
            ? "Este lead ya tiene una venta cerrada"
            : "Este lead ya fue descartado",
      });
    }

    const lead = await prisma.lead.update({
      where: { id },
      data: {
        // Sale de la lista de la vendedora y entra a la cola marcado, para
        // que la coordinadora lo vea y no se pierda entre los demas.
        vendedorId: null,
        asignadoAt: null,
        asignadoPorCoordinador: false,
        requiereSupervision: true,
        supervisionNota: nota || null,
        supervisionPedidaAt: new Date(),
        status: fechaReagenda ? "REAGENDADO" : existing.status,
        ...(fechaReagenda ? { fechaReagenda } : {}),
        // La espera del protocolo no aplica: aqui no es que no contestara,
        // es que el cliente pidio algo concreto y hay que atenderlo.
        disponibleDesde: null,
        devueltoAt: new Date(),
        devueltoMotivo: nota || "El cliente pidio que le llamaran en otro momento",
        devueltoPorNombre: req.user.nombre || "Vendedora",
      },
    });

    detallarMovimiento(req, {
      entidadId: id,
      descripcion: `Pasó a supervisión el lead ${lead.nombre}`,
      antes: existing,
      despues: lead,
    });

    res.json({ ok: true, lead: await ocultarTelefonoLead(lead, req.user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/leads/:id/devolver — la vendedora regresa a la cola un lead que
// no contesto en su turno, para que la coordinadora lo reasigne a otra
// persona en vez de que se pierda hasta el dia siguiente.
router.post("/:id/devolver", authMiddleware, requirePermiso("vendedor.leads.devolver"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const motivo = typeof req.body?.motivo === "string" ? req.body.motivo.trim().slice(0, 300) : "";

    const existing = await prisma.lead.findFirst({ where: { id, vendedorId: req.user.id } });
    if (!existing) return res.status(404).json({ error: "Lead no encontrado" });

    // Solo se devuelve lo que sigue vivo: una venta cerrada o un descarte ya
    // no son trabajo pendiente de nadie.
    if (!LEAD_STATUSES_ABIERTOS.includes(existing.status)) {
      return res.status(409).json({
        error:
          existing.status === "VENTA"
            ? "Este lead ya tiene una venta cerrada"
            : "Este lead ya fue descartado",
      });
    }

    const lead = await prisma.lead.update({
      where: { id },
      data: {
        vendedorId: null,
        asignadoAt: null,
        asignadoPorCoordinador: false,
        devueltoAt: new Date(),
        devueltoMotivo: motivo || "No contestó durante el turno",
        devueltoPorNombre: req.user.nombre,
      },
    });

    // Devolver casi siempre es "no contestó en mi turno": queda en el
    // historial para que la siguiente vendedora vea cuántas veces se
    // intentó antes y no empiece de cero.
    await registrarResultado({
      leadId: id,
      vendedorId: req.user.id,
      tenantId: req.user.tenantId,
      resultado: "DEVUELTO_A_COLA",
      notas: lead.devueltoMotivo,
      estadoAntes: existing.status,
      estadoDespues: existing.status,
      // Devolver el lead es casi siempre "no contestó": no puede contar
      // como conversación.
      implicaContacto: false,
    });

    detallarMovimiento(req, {
      entidadId: id,
      descripcion: `Devolvió a la cola el lead ${existing.nombre}`,
      antes: { vendedor: req.user.nombre, status: existing.status },
      despues: { vendedor: "sin asignar", motivo: lead.devueltoMotivo },
    });

    res.json({ message: "Lead devuelto a la cola de asignación", leadId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/leads/:id/ticket-sms — manda el ticket de compra (folio, monto)
// por SMS desde el número de la empresa (no WhatsApp personal, ver
// src/lib/twilioSms.js).
router.post("/:id/ticket-sms", authMiddleware, async (req, res) => {
  try {
    if (!smsEnabled()) return res.status(503).json({ error: "Envío de SMS no configurado" });

    const id = parseInt(req.params.id);
    const lead = await prisma.lead.findFirst({
      where: { id, vendedorId: req.user.id },
      include: { venta: true },
    });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });
    if (!lead.telefono) return res.status(400).json({ error: "El lead no tiene teléfono" });
    if (!lead.venta) return res.status(400).json({ error: "Este lead aún no tiene una venta registrada" });

    const mensaje = `¡Gracias por tu compra, ${lead.nombre}! Folio: ${lead.folio ?? lead.venta.folio ?? "-"}. Producto: ${lead.producto} (x${lead.cantidad}). Total: $${lead.venta.monto + (lead.venta.costoEnvio || 0)}. En breve recibirás tu pedido.`;

    await sendSms(lead.telefono, mensaje);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al enviar el SMS" });
  }
});

// POST /api/leads/:id/solicitar-ubicacion — SMS con link a una página
// pública (app/compartir-ubicacion/[token]) donde el cliente comparte su
// ubicación desde el navegador -- reemplaza el wa.me que dependía del
// WhatsApp personal de la vendedora.
router.post("/:id/solicitar-ubicacion", authMiddleware, async (req, res) => {
  try {
    if (!smsEnabled()) return res.status(503).json({ error: "Envío de SMS no configurado" });
    if (!process.env.FRONTEND_URL) return res.status(503).json({ error: "FRONTEND_URL no configurado" });

    const id = parseInt(req.params.id);
    const lead = await prisma.lead.findFirst({ where: { id, vendedorId: req.user.id } });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });
    if (!lead.telefono) return res.status(400).json({ error: "El lead no tiene teléfono" });

    const token = crypto.randomBytes(16).toString("hex");
    await prisma.lead.update({
      where: { id },
      // ubicacionCompartidaAt se limpia para que una solicitud nueva no
      // arrastre la respuesta de la anterior y parezca ya contestada.
      data: { ubicacionToken: token, ubicacionSolicitadaAt: new Date(), ubicacionCompartidaAt: null },
    });

    const link = `${process.env.FRONTEND_URL}/compartir-ubicacion/${token}`;
    const mensaje = `Hola ${lead.nombre}, para completar tu entrega compártenos tu ubicación: ${link}`;
    await sendSms(lead.telefono, mensaje);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al enviar el SMS" });
  }
});

module.exports = router;
