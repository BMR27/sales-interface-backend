const express = require("express");
const authMiddleware = require("../middleware/auth");
const { syncVentaToFullVector } = require("../lib/fullvector");
const { calcularQuincenaVendedora, recalcularQuincena } = require("../lib/comisiones");
const { filtroLead } = require("../lib/accesoLead");
const { emitir } = require("../lib/eventos");
const { getParametros } = require("../lib/parametros");
const { crearAviso } = require("../lib/avisos");
const { aplicarCobroALaVenta, bloqueoPorLinkPendiente, cobroDelLead } = require("../lib/linksPago");
const { linkConFicha, datosDePagoPendiente } = require("../lib/ventaPagoPendiente");

const router = express.Router();
const prisma = require("../lib/prisma");
const { inicioDeHoy, inicioDeSemana, inicioDeMes } = require("../lib/fechasLocales");

// GET /api/ganancias
router.get("/", authMiddleware, async (req, res) => {
  try {
    const vendedorId = req.user.id;
    const ahora = new Date();

    // Hora de la operacion, no del servidor (ver src/lib/fechasLocales.js):
    // con setHours(0,0,0,0) la ganancia "de hoy" ya contaba desde las 18:00
    // del dia anterior.
    const inicioDia = inicioDeHoy(ahora);
    const inicioSemana = inicioDeSemana(ahora);
    const inicioMes = inicioDeMes(ahora);

    const [hoy, semana, mes, recientes] = await Promise.all([
      prisma.venta.aggregate({ where: { vendedorId, fecha: { gte: inicioDia } }, _sum: { monto: true, comision: true } }),
      prisma.venta.aggregate({ where: { vendedorId, fecha: { gte: inicioSemana } }, _sum: { monto: true, comision: true } }),
      prisma.venta.aggregate({ where: { vendedorId, fecha: { gte: inicioMes } }, _sum: { monto: true, comision: true } }),
      prisma.venta.findMany({
        where: { vendedorId },
        include: { lead: { select: { producto: true } } },
        orderBy: { fecha: "desc" },
        take: 10,
      }),
    ]);

    const { comisionPorcentaje, metaMensual } = await getParametros(req.user.tenantId);

    // Lo que de verdad le importa a la vendedora con el modelo por bloques:
    // cuantas piezas lleva en la quincena, cuantos bloques pago eso y
    // cuantas piezas le faltan para el siguiente bloque.
    const quincena = await calcularQuincenaVendedora(req.user.tenantId, vendedorId, new Date());

    res.json({
      hoy: { monto: hoy._sum.monto || 0, comision: hoy._sum.comision || 0 },
      semana: { monto: semana._sum.monto || 0, comision: semana._sum.comision || 0 },
      mes: { monto: mes._sum.monto || 0, comision: mes._sum.comision || 0 },
      quincena: {
        etiqueta: quincena.quincena.etiqueta,
        piezas: quincena.piezas,
        bloques: quincena.bloques,
        sobrantes: quincena.sobrantes,
        faltanParaBloque: quincena.sobrantes === 0 ? quincena.porBloque : quincena.porBloque - quincena.sobrantes,
        comision: quincena.comision,
        porBloque: quincena.porBloque,
        importeBloque: quincena.importeBloque,
        // Piezas vendidas que todavia no pagan porque FullVector no confirma
        // la entrega: es la pregunta numero uno cuando el numero no cuadra.
        piezasSinConfirmar: quincena.ventas.filter((v) => !v.cuenta).reduce((s, v) => s + v.piezas, 0),
      },
      metaMensual,
      comisionPorcentaje,
      recientes: recientes.map(v => ({
        fecha: v.fecha,
        producto: v.lead.producto,
        monto: v.monto,
        comision: v.comision,
        folio: v.folio,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/ganancias/venta — registrar venta cerrada
router.post("/venta", authMiddleware, async (req, res) => {
  try {
    const { leadId, monto, costoEnvio, folio } = req.body;
    if (!leadId || !monto) {
      return res.status(400).json({ error: "leadId y monto requeridos" });
    }

    const lead = await prisma.lead.findFirst({ where: filtroLead(req.user, leadId) });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });

    // A quien se le acredita la venta.
    //
    // Si el lead ya tiene vendedora, es suya aunque la cierre la
    // coordinadora: ella acompaña la llamada, no se queda con la venta. Si
    // no tiene dueña -- un lead de la cola que la coordinadora trabajo ella
    // misma -- se le acredita a quien la cerro, que es quien la hizo.
    const vendedorDeLaVenta = lead.vendedorId ?? req.user.id;

    const ventaExistente = await prisma.venta.findUnique({ where: { leadId } });
    if (ventaExistente) {
      return res.status(409).json({ error: "Este lead ya tiene una venta registrada" });
    }

    // El cobro por link decide cómo nace la venta (ver src/lib/linksPago.js):
    // con un link vivo no se cierra, y con uno pagado nace prepagada para
    // que FullVector no la cobre otra vez al entregar.
    const bloqueo = await bloqueoPorLinkPendiente(lead);
    if (bloqueo) return res.status(409).json({ error: bloqueo, linkPendiente: true });
    const { pagado } = await cobroDelLead(leadId);
    // Con la ficha OXXO o la CLABE generadas y sin pagar, la venta se cierra
    // marcada y espera al pago para salir (ver src/lib/ventaPagoPendiente.js).
    const conFicha = pagado ? null : await linkConFicha(leadId);

    // La comision se calcula por bloques de piezas sobre la quincena (ver
    // src/lib/comisiones.js), no como porcentaje de esta venta: nace en 0 y
    // la recalcula recalcularQuincena mas abajo. `entregaExitosa` tampoco se
    // acepta del cliente -- la entrega la confirma FullVector.
    let venta = await prisma.venta.create({
      data: {
        leadId, vendedorId: vendedorDeLaVenta, monto, comision: 0,
        costoEnvio: Number(costoEnvio) || 0,
        folio: folio || null,
        tenantId: req.user.tenantId,
        // Pagada con el link antes de cerrar: la orden sale con $0 por
        // cobrar. A diferencia de las de la landing, `sinComision` se queda
        // en false -- la cerró una vendedora y la comisión es suya.
        ...(pagado
          ? {
              prepagada: true,
              pagoProveedor: "Stripe",
              pagoReferencia: pagado.stripePaymentIntentId || pagado.stripeSessionId,
              pagadoAt: pagado.pagadoAt || new Date(),
            }
          : conFicha
            ? datosDePagoPendiente(conFicha)
            : {}),
      },
    });

    let finalFolio = folio;
    if (!finalFolio) {
      finalFolio = `PS${new Date().getFullYear()}-${String(venta.id).padStart(5, "0")}`;
      venta = await prisma.venta.update({ where: { id: venta.id }, data: { folio: finalFolio } });
    }

    await prisma.lead.update({
      where: { id: leadId },
      data: {
        status: "VENTA", monto, folio: finalFolio,
        // Un lead vendido no puede quedarse sin dueña: si se cerro desde la
        // cola, queda a nombre de quien lo trabajo. Si no, se respeta la
        // vendedora que ya tenia.
        ...(lead.vendedorId ? {} : { vendedorId: vendedorDeLaVenta, asignadoAt: new Date() }),
      },
    });

    const leadItems = await prisma.leadItem.findMany({ where: { leadId } });

    if (leadItems.length > 0) {
      const ops = [];
      for (const item of leadItems) {
        const producto = await prisma.producto.findUnique({ where: { id: item.productoId } });
        if (!producto) continue;
        const nuevoStock = producto.stock - item.cantidad;
        ops.push(
          prisma.producto.update({ where: { id: producto.id }, data: { stock: nuevoStock } }),
          prisma.movimientoInventario.create({
            data: {
              productoId: producto.id,
              tipo: "SALIDA",
              cantidad: -item.cantidad,
              stockResultante: nuevoStock,
              motivo: `Venta #${finalFolio}`,
              tenantId: req.user.tenantId,
              ventaId: venta.id,
            },
          }),
        );
      }
      if (ops.length) await prisma.$transaction(ops);
    } else if (lead.productoId) {
      const producto = await prisma.producto.findUnique({ where: { id: lead.productoId } });
      if (producto) {
        const cantidad = lead.cantidad || 1;
        const nuevoStock = producto.stock - cantidad;
        await prisma.$transaction([
          prisma.producto.update({ where: { id: producto.id }, data: { stock: nuevoStock } }),
          prisma.movimientoInventario.create({
            data: {
              productoId: producto.id,
              tipo: "SALIDA",
              cantidad: -cantidad,
              stockResultante: nuevoStock,
              motivo: `Venta #${finalFolio}`,
              tenantId: req.user.tenantId,
              ventaId: venta.id,
            },
          }),
        ]);
      }
    }

    // La pieza recien vendida puede completar un bloque de dias anteriores:
    // se recalcula la quincena completa de la vendedora.
    // Se recalcula la de quien cobra la venta, que no siempre es quien la
    // registro: la coordinadora puede cerrarla por la vendedora.
    await recalcularQuincena(req.user.tenantId, vendedorDeLaVenta, venta.fecha).catch((err) => {
      console.error("no se pudo recalcular la comision de la quincena", err);
    });

    emitir(req.user.tenantId, "venta.cerrada", { leadId, monto });

    // Con el pago pendiente no sale todavía: se manda sola cuando pague.
    if (!venta.pagoPendiente) {
      syncVentaToFullVector(venta.id).catch((err) => {
        console.error("fullvector sync error, venta", venta.id, err);
      });
    }

    // Si el cliente ya pagó con el link a media llamada, la venta nace
    // pagada (ver src/lib/linksPago.js). No lanza.
    await aplicarCobroALaVenta(leadId);

    // A la coordinadora que repartió este lead le interesa saber que
    // convirtió: es su comisión y es la señal de que repartió bien.
    if (lead.asignadoPorId && lead.asignadoPorId !== req.user.id) {
      crearAviso({
        userId: lead.asignadoPorId,
        tenantId: req.user.tenantId,
        tipo: "venta.convertida",
        categoria: "EXITO",
        titulo: "Un lead que asignaste se convirtió",
        mensaje: `${req.user.nombre} cerró la venta de ${lead.nombre} por $${Math.round(monto).toLocaleString("es-MX")}.`,
        enlace: "/coordinador/progreso",
      });
    }

    res.status(201).json(venta);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
