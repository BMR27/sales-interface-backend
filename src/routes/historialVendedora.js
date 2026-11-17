// El Historial de la vendedora: lo que concretó y lo que cobró.
//
// Dos preguntas distintas que antes no tenían dónde contestarse. La
// vendedora veía su comisión de la quincena como un número vivo en el
// tablero, y sus ventas se perdían entre los leads cerrados de su
// listado -- que además ahora ya no los trae, porque ese listado es para
// trabajar.
//
//   Concretadas  qué vendió, con lo mínimo para reconocer cada venta
//   Comisiones   qué se le debe, en tickets diarios que se firman
//
// Lo que NO está aquí: el detalle operativo del lead (llamadas, motivos,
// direcciones). Eso vive en el lead y en los reportes de administración.
// Este módulo contesta "cuánto hice y cuánto me toca", nada más.
const express = require("express");
const authMiddleware = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { inicioDeDia, finDeDia } = require("../lib/fechasLocales");
const {
  ESTATUS_LABEL, generarTicket, firmar,
} = require("../lib/ticketsComision");

const router = express.Router();
router.use(authMiddleware);

// GET /api/mi-historial/concretadas?desde=&hasta=
//
// Solo lo básico, que es lo que pidió operación: nombre, producto,
// piezas, importe, comisión y en qué va la entrega. No lleva teléfono ni
// dirección -- para volver a contactar al cliente está el lead, y una
// lista exportable con datos de contacto es justo lo que no conviene
// tener suelto.
router.get("/concretadas", async (req, res) => {
  try {
    const vendedorId = req.user.id;
    const desde = inicioDeDia(req.query.desde);
    const hasta = finDeDia(req.query.hasta);

    const ventas = await prisma.venta.findMany({
      where: {
        tenantId: req.user.tenantId,
        vendedorId,
        ...(desde || hasta ? { fecha: { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) } } : {}),
      },
      orderBy: { fecha: "desc" },
      take: 500,
      select: {
        id: true, folio: true, fecha: true, monto: true, costoEnvio: true, comision: true,
        cancelada: true, entregaExitosa: true, fullvectorSyncStatus: true, fullvectorSinCobertura: true,
        lead: {
          select: {
            folioPS: true, nombre: true, producto: true,
            items: { select: { cantidad: true, esRegalo: true, producto: { select: { nombre: true } } } },
          },
        },
      },
    });

    res.json({
      concretadas: ventas.map((v) => {
        const items = v.lead?.items || [];
        return {
          id: v.id,
          folio: v.folio,
          folioPS: v.lead?.folioPS ?? null,
          fecha: v.fecha,
          cliente: v.lead?.nombre ?? "",
          producto: v.lead?.producto ?? "",
          // Las piezas que se cobran. Los regalos no cuentan: no son
          // venta y confundirlos infla lo que la vendedora cree haber
          // hecho.
          piezas: items.filter((i) => !i.esRegalo).reduce((s, i) => s + i.cantidad, 0),
          articulos: items
            .map((i) => `${i.cantidad}x ${i.producto?.nombre ?? "?"}${i.esRegalo ? " (regalo)" : ""}`)
            .join(", "),
          monto: v.monto,
          envio: v.costoEnvio || 0,
          total: v.monto + (v.costoEnvio || 0),
          comision: v.comision || 0,
          // El estatus en PS, en las palabras que usa la operación.
          estatus: v.cancelada
            ? "Cancelada"
            : v.fullvectorSyncStatus !== "SYNCED"
              ? "No llegó a FullVector"
              : v.fullvectorSinCobertura
                ? "Prepago (sin COD)"
                : v.entregaExitosa
                  ? "Entregada"
                  : "En tránsito",
        };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/mi-historial/comisiones
//
// Los tickets de la vendedora. Antes de devolverlos se intenta cerrar el
// de HOY: el cierre normal lo hace el job de fin de jornada, pero si
// alguien entra a mirar antes de que corra, es mejor que vea el ticket
// del día en aprobación que una lista que no cuadra con lo que vendió.
router.get("/comisiones", async (req, res) => {
  try {
    const vendedorId = req.user.id;
    await generarTicket(req.user.tenantId, vendedorId).catch(() => {});

    const tickets = await prisma.ticketComision.findMany({
      where: { tenantId: req.user.tenantId, vendedorId },
      orderBy: { fecha: "desc" },
      take: 120,
      include: { aprobadoPor: { select: { nombre: true } } },
    });

    res.json({
      tickets: tickets.map((t) => ({
        ...t,
        estatusLabel: ESTATUS_LABEL[t.estatus] ?? t.estatus,
      })),
      // Lo que ya está aprobado y todavía no se firma: es lo que la
      // vendedora tiene por cobrar.
      porCobrar: tickets.filter((t) => t.estatus === "APROBADO").reduce((s, t) => s + t.monto, 0),
      // Lo cobrado, para que la cifra de arriba se lea contra algo.
      liquidado: tickets.filter((t) => t.estatus === "LIQUIDADO").reduce((s, t) => s + t.monto, 0),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/mi-historial/comisiones/:id/firmar  { password }
//
// La firma de recibido. Pide la contraseña porque lo que se afirma es
// "recibí este dinero", y un clic sin credencial no distingue a la
// persona de quien se quedó en su sesión abierta.
router.post("/comisiones/:id/firmar", async (req, res) => {
  try {
    const { ticket, error } = await firmar(
      req.user.tenantId,
      parseInt(req.params.id),
      req.user,
      req.body?.password
    );
    if (error) return res.status(400).json({ error });
    res.json({ ticket });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
