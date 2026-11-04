const express = require("express");
const authMiddleware = require("../middleware/auth");
const { requirePermiso, tienePermiso } = require("../lib/permisosCatalog");
const { registrarResultado } = require("../lib/historialLlamadas");
const { ocultarTelefonoLead } = require("../lib/telefono");
const { getParametros } = require("../lib/parametros");
const { detallarMovimiento } = require("../lib/auditoria");
const { motivoLabel } = require("../lib/motivosDescarte");
const {
  RESULTADOS,
  SUBMOTIVOS_RECHAZO_COMPRA,
  SUBMOTIVO_REQUIERE_NOTA,
  EFECTO_TRASH,
  parseResultado,
} = require("../lib/resultadosLlamada");
const { registrarResultadoLlamada, programarRellamada } = require("../lib/cicloLead");

// Quien puede abrir y trabajar un lead desde el panel de llamada.
//
// La vendedora, solo los suyos. La coordinadora, cualquiera de su empresa:
// su papel incluye enseñar a llamar, y para eso se sienta con la vendedora
// sobre el lead que esa vendedora tiene enfrente.
//
// El intento queda registrado a nombre de quien marca (Llamada.vendedorId
// es una relacion a User, no solo a vendedoras), asi que el historial del
// lead dice la verdad: llamo la coordinadora.

const { filtroLead } = require("../lib/accesoLead");

const router = express.Router();
const prisma = require("../lib/prisma");

// GET /api/llamada/resultados — el catálogo del modal "Resultado de
// llamada", para que la pantalla lo dibuje sin tenerlo duplicado del lado
// del navegador. Duplicarlo garantizaba que tarde o temprano el modal
// ofreciera una opción que el servidor ya no acepta.
//
// Va ANTES de GET /:id: Express casa por orden de declaración, y declarada
// después caería en el comodín del id.
router.get("/resultados", authMiddleware, async (req, res) => {
  try {
    const { rellamarMaxDias, esperaNoContestaMin, esperaRechazaMin, esperaFueraServicioMin } =
      await getParametros(req.user.tenantId);

    // Las esperas se mandan ya resueltas para que el modal pueda decir
    // "vuelve en 2 h" con el valor real de la empresa y no uno fijo en el
    // código, que es como se desincroniza una advertencia.
    const ESPERA = {
      NO_CONTESTA: esperaNoContestaMin,
      RECHAZA: esperaRechazaMin,
      FUERA_DE_SERVICIO: esperaFueraServicioMin,
    };

    res.json({
      resultados: RESULTADOS.map((r) => ({
        clave: r.clave,
        label: r.label,
        ayuda: r.ayuda,
        efecto: r.efecto,
        icono: r.icono,
        requiereSubmotivo: Boolean(r.requiereSubmotivo),
        requiereConfirmacion: Boolean(r.requiereConfirmacion),
        esperaMinutos: r.desenlace ? ESPERA[r.desenlace] ?? null : null,
      })),
      // Los motivos de "Cliente rechaza compra", con la etiqueta del
      // catálogo de descarte: son las mismas claves, no una lista aparte.
      submotivos: SUBMOTIVOS_RECHAZO_COMPRA.map((clave) => ({
        clave,
        label: motivoLabel(clave),
        requiereNota: clave === SUBMOTIVO_REQUIERE_NOTA,
      })),
      rellamarMaxDias,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/llamada/:id — info del lead para la llamada
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: filtroLead(req.user, parseInt(req.params.id)),
      include: {
        productoCatalogo: true,
        items: { include: { producto: true } },
      },
    });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });

    const producto = lead.productoCatalogo;
    const promociones = producto?.ofertasTiers || [];

    const productos = await prisma.producto.findMany({
      where: { activo: true, tenantId: req.user.tenantId },
      orderBy: { nombre: "asc" },
    });

    res.json({
      // El numero completo no sale del servidor: el marcador manda el id del
      // lead y el webhook de TwiML resuelve a que numero llamar.
      lead: await ocultarTelefonoLead(lead, req.user),
      // Un lead con venta cerrada se puede consultar pero no volver a
      // vender: la dirección y la ubicación compartida se siguen
      // necesitando a la vista para completar el envío. Quien bloquea de
      // verdad la doble venta es confirmar/reagendar/rechazar, cada uno
      // con su propia guarda.
      ventaCerrada: lead.status === "VENTA",
      producto: producto
        ? { id: producto.id, nombre: producto.nombre, ofertasTexto: producto.ofertas, beneficios: producto.beneficios }
        : null,
      promociones,
      productos: productos.map((p) => ({
        id: p.id,
        nombre: p.nombre,
        sku: p.sku,
        categoria: p.categoria,
        ofertasTexto: p.ofertas,
        beneficios: p.beneficios,
        pvpLeadsCpa: p.pvpLeadsCpa,
        ofertasTiers: p.ofertasTiers || [],
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/llamada/:id/confirmar — registra resultado de la llamada (carrito de productos)
router.post("/:id/confirmar", authMiddleware, requirePermiso("vendedor.leads.confirmar_venta"), async (req, res) => {
  try {
    const leadId = parseInt(req.params.id);
    const { duracion, resultado, notas, aceptoOferta, items } = req.body;

    const lead = await prisma.lead.findFirst({
      where: filtroLead(req.user, leadId),
    });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });
    if (lead.status === "VENTA") {
      return res.status(409).json({ error: "Este lead ya tiene una venta cerrada" });
    }

    const cartItems = Array.isArray(items) ? items : [];
    if (aceptoOferta && cartItems.length > 0) {
      for (const item of cartItems) {
        if (!item.productoId || !item.cantidad || item.precioUnitario == null) {
          return res.status(400).json({ error: "Cada producto del carrito requiere productoId, cantidad y precioUnitario" });
        }
      }
    }

    const productoNombres = cartItems.length
      ? Object.fromEntries(
          (
            await prisma.producto.findMany({
              where: { id: { in: cartItems.map((i) => i.productoId) } },
              select: { id: true, nombre: true },
            })
          ).map((p) => [p.id, p.nombre])
        )
      : {};

    const ofertas =
      aceptoOferta && cartItems.length > 0
        ? cartItems.map((i) =>
            i.esRegalo
              ? `${i.cantidad}x ${productoNombres[i.productoId] || "Producto"} - GRATIS (regalo)`
              : `${i.cantidad}x ${productoNombres[i.productoId] || "Producto"} - $${i.precioUnitario}/u`
          )
        : [];

    // Completa el intento que creó el marcador (o crea la fila si llamó por
    // fuera). El estatus no se mueve aquí: sigue pendiente hasta que la
    // venta se registre, así que `estadoDespues` es el que ya tenía.
    await registrarResultado({
      leadId,
      vendedorId: req.user.id,
      tenantId: req.user.tenantId,
      duracion,
      ofertas,
      resultado,
      notas,
      estadoAntes: lead.status,
      estadoDespues: lead.status,
    });

    if (aceptoOferta && cartItems.length > 0) {
      const montoTotal = cartItems.reduce((sum, i) => sum + i.precioUnitario * i.cantidad, 0);
      const cantidadTotal = cartItems.reduce((sum, i) => sum + i.cantidad, 0);

      await prisma.$transaction([
        prisma.leadItem.deleteMany({ where: { leadId } }),
        prisma.leadItem.createMany({
          data: cartItems.map((i) => ({
            leadId,
            productoId: i.productoId,
            cantidad: i.cantidad,
            precioUnitario: i.precioUnitario,
            esRegalo: Boolean(i.esRegalo),
            tenantId: req.user.tenantId,
          })),
        }),
        // El estatus no se mueve aquí: el lead sigue siendo un pendiente
        // hasta que la venta se registre (ahí pasa a VENTA/Concretado) o se
        // descarte. Solo se guarda lo que el cliente aceptó en el carrito.
        prisma.lead.update({
          where: { id: leadId },
          data: { monto: montoTotal, cantidad: cantidadTotal },
        }),
      ]);
    }

    res.json({ message: "Llamada registrada", leadId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/llamada/:id/resultado — la vendedora registra qué pasó.
//
// Sustituye a DELETE /api/leads/:id (descartar), POST /:id/devolver y
// POST /:id/supervision. Ella dice lo que vio; el estatus, la cola y los
// tiempos los deriva src/lib/cicloLead.js. No recibe ningún estatus: el
// documento es explícito en que la vendedora no elige si el lead queda en
// Trash o No concretado, y permitírselo fue lo que produjo los descartes
// prematuros que este cambio corrige.
router.post("/:id/resultado", authMiddleware, async (req, res) => {
  try {
    const leadId = parseInt(req.params.id);
    const { resultado, submotivo, nota, duplicadoDe, token } = req.body ?? {};

    // El acceso se valida con el mismo filtro de siempre ANTES de tocar
    // nada: la vendedora solo sus leads, la coordinadora los de su empresa.
    const permitido = await prisma.lead.findFirst({
      where: filtroLead(req.user, leadId),
      select: { id: true },
    });
    if (!permitido) return res.status(404).json({ error: "Lead no encontrado" });

    // Los permisos que ya existían siguen mandando, repartidos según lo que
    // el resultado provoca: cerrar un lead es "descartar" y devolverlo a la
    // cola es "devolver". Sin esto, el botón nuevo habría sido una puerta
    // trasera a dos acciones que la empresa puede tener apagadas.
    const def = parseResultado(resultado);
    if (def) {
      const clave = def.efecto === EFECTO_TRASH ? "vendedor.leads.rechazar" : "vendedor.leads.devolver";
      if (!(await tienePermiso(req.user, clave))) {
        return res.status(403).json({ error: "No tienes permiso para realizar esta acción" });
      }
    }

    const salida = await registrarResultadoLlamada({
      leadId,
      tenantId: req.user.tenantId,
      usuario: { id: req.user.id, nombre: req.user.nombre },
      resultado,
      submotivo,
      nota,
      duplicadoDe,
      token,
    });

    if (salida?.error) return res.status(salida.status ?? 400).json({ error: salida.error });

    detallarMovimiento(req, {
      entidad: "Lead",
      entidadId: leadId,
      descripcion: `Registró "${def?.label ?? resultado}" en el lead ${salida.lead?.nombre ?? leadId}`,
      despues: { status: salida.lead?.status, substatus: salida.lead?.substatus },
    });

    res.json(salida);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/llamada/:id/rellamada — la rellamada vigente, si la hay.
//
// El modal la precarga en vez de crear una segunda: el documento pide
// impedir dos rellamadas activas para el mismo lead, y la forma de
// impedirlo que no pierde trabajo es que la segunda vez se edite la misma.
router.get("/:id/rellamada", authMiddleware, async (req, res) => {
  try {
    const lead = await prisma.lead.findFirst({
      where: filtroLead(req.user, parseInt(req.params.id)),
      select: {
        fechaReagenda: true,
        status: true,
        supervisionNota: true,
        reagendaVendedorSugerido: { select: { id: true, nombre: true } },
      },
    });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });

    const vigente = lead.status === "REAGENDADO" && lead.fechaReagenda && lead.fechaReagenda > new Date();

    res.json({
      rellamada: vigente
        ? {
            fecha: lead.fechaReagenda,
            nota: lead.supervisionNota,
            generadaPor: lead.reagendaVendedorSugerido,
          }
        : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/llamada/:id/rellamar — el cliente pidió que le llamen en otro
// momento. Sustituye a POST /:id/reagendar y a POST /api/leads/:id/supervision:
// eran dos botones para el mismo hecho, y cuál usar dependía de que la
// vendedora supiera de memoria si la hora caía en su turno.
router.post("/:id/rellamar", authMiddleware, requirePermiso("vendedor.leads.reagendar"), async (req, res) => {
  try {
    const leadId = parseInt(req.params.id);
    const { fecha, nota, token } = req.body ?? {};

    const permitido = await prisma.lead.findFirst({
      where: filtroLead(req.user, leadId),
      select: { id: true },
    });
    if (!permitido) return res.status(404).json({ error: "Lead no encontrado" });

    const salida = await programarRellamada({
      leadId,
      tenantId: req.user.tenantId,
      usuario: { id: req.user.id, nombre: req.user.nombre },
      fecha,
      nota,
      token,
    });

    if (salida?.error) {
      return res.status(salida.status ?? 400).json({ error: salida.error, limite: salida.limite });
    }

    detallarMovimiento(req, {
      entidad: "Lead",
      entidadId: leadId,
      descripcion: `Agendó una rellamada del lead ${salida.lead?.nombre ?? leadId}`,
      despues: { fechaReagenda: salida.fechaReagenda, accion: salida.accion },
    });

    res.json(salida);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
