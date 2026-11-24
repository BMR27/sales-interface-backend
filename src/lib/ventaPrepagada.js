// Venta pagada en línea antes del envío (landing PerfectSelf con Stripe).
//
// A diferencia de un lead, aquí no hay nada que trabajar: el cliente ya
// eligió, dio su dirección y pagó. Por eso entra directo como venta
// concretada (lead en VENTA), a nombre de la cuenta "Tienda en línea" -- que
// no recibe leads ni comisión -- y su orden va a FullVector con orderValue 0
// para que el mensajero no cobre nada. La entrega exitosa la sigue dictando
// FullVector, igual que en cualquier otra venta.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const prisma = require("./prisma");
const { siguienteFolio } = require("./folios");
const { resolverProducto } = require("./catalogoProducto");
const { syncVentaToFullVector } = require("./fullvector");

const TIENDA_NOMBRE = "Tienda en línea";

class VentaPrepagadaError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Usuario al que se acreditan las ventas en línea. Inactivo a propósito: así
// el reparto automático (que solo toma vendedoras activas) nunca le asigna
// leads y nadie puede entrar con él.
async function cuentaTiendaEnLinea(tenantId) {
  const email = `tienda-en-linea+${tenantId}@sistema.local`;
  const existente = await prisma.user.findUnique({ where: { email } });
  if (existente) return existente;
  return prisma.user.create({
    data: {
      nombre: TIENDA_NOMBRE,
      email,
      password: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10),
      rol: "VENDEDOR",
      activo: false,
      tenantId,
    },
  });
}

const texto = (v, max = 200) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max));

function validar(body) {
  const faltan = [];
  const folio = texto(body.folio, 60);
  if (!folio) faltan.push("folio");
  const cliente = body.cliente || {};
  if (!texto(cliente.nombre)) faltan.push("cliente.nombre");
  if (!texto(cliente.telefono)) faltan.push("cliente.telefono");
  const d = body.direccion || {};
  for (const k of ["calle", "colonia", "estado", "codigoPostal"]) if (!texto(d[k])) faltan.push(`direccion.${k}`);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) faltan.push("items");
  if (!(Number(body.monto) > 0)) faltan.push("monto");
  if (!texto(body.pago?.referencia)) faltan.push("pago.referencia");
  if (faltan.length) throw new VentaPrepagadaError(`Faltan campos: ${faltan.join(", ")}`);
  for (const it of items) {
    if (!texto(it.sku) || !(Number.isInteger(Number(it.cantidad)) && Number(it.cantidad) > 0)) {
      throw new VentaPrepagadaError("Cada item necesita sku y cantidad entera positiva");
    }
  }
  return { folio, cliente, d, items };
}

// El municipio no siempre viene (la landing pide CP, colonia y calle): se toma
// del catálogo de códigos postales, primero por colonia y luego el del CP.
async function municipioDe(cp, colonia) {
  const filas = await prisma.codigoPostal.findMany({ where: { cp }, select: { colonia: true, municipio: true } });
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
  const exacta = filas.find((f) => norm(f.colonia) === norm(colonia) && f.municipio);
  return exacta?.municipio || filas.find((f) => f.municipio)?.municipio || null;
}

async function ventaExistente(tenantId, folio) {
  const venta = await prisma.venta.findFirst({ where: { tenantId, folio, prepagada: true } });
  return venta && prisma.venta.findUnique({ where: { id: venta.id }, include: { lead: true } });
}

function respuesta(venta, existente) {
  return {
    existente,
    ventaId: venta.id,
    leadId: venta.leadId,
    folio: venta.folio,
    folioPS: venta.lead?.folioPS || null,
    status: venta.lead?.status || "VENTA",
    fullvector: {
      status: venta.fullvectorSyncStatus,
      orderId: venta.fullvectorOrderId,
      sinCobertura: venta.fullvectorSinCobertura,
      error: venta.fullvectorError,
    },
  };
}

/**
 * Registra (una sola vez por folio) la venta prepagada y la manda a
 * FullVector. Devuelve el estado de la venta y de su orden en FullVector.
 */
async function registrarVentaPrepagada(body, { tenantId, apiKey }) {
  const { folio, cliente, d, items } = validar(body || {});

  const ya = await ventaExistente(tenantId, folio);
  if (ya) {
    if (ya.fullvectorSyncStatus !== "SYNCED") await syncVentaToFullVector(ya.id);
    return respuesta(await prisma.venta.findUnique({ where: { id: ya.id }, include: { lead: true } }), true);
  }

  // Productos del catálogo del CRM por SKU (los SKU de la landing son los internos).
  const lineas = [];
  for (const it of items) {
    const producto = await resolverProducto({ tenantId, internalSku: it.sku, externalSku: `BGW-${it.sku}`, nombre: it.nombre });
    if (!producto) throw new VentaPrepagadaError(`Producto no encontrado en el catálogo: ${it.sku}`, 404);
    lineas.push({
      producto,
      cantidad: Number(it.cantidad),
      esRegalo: it.regalo === true,
      precioUnitario: it.regalo === true ? 0 : Number(it.precioUnitario) || 0,
    });
  }
  const principal = lineas.find((l) => !l.esRegalo) || lineas[0];
  const piezas = lineas.reduce((s, l) => s + l.cantidad, 0);
  const monto = Number(body.monto);
  const costoEnvio = Number(body.costoEnvio) || 0;
  const pago = body.pago || {};
  const pagadoAt = pago.pagadoAt ? new Date(pago.pagadoAt) : new Date();
  const comprobanteUrl = texto(body.comprobanteUrl, 1000) || null;
  const cp = texto(d.codigoPostal, 10);
  const colonia = texto(d.colonia, 120);
  const municipio = texto(d.municipio, 120) || (await municipioDe(cp, colonia));
  const referencias = [texto(d.referencias, 240), texto(d.fachada, 240), d.interior ? `Int. ${texto(d.interior, 20)}` : ""]
    .filter(Boolean).join(" · ") || null;

  const tienda = await cuentaTiendaEnLinea(tenantId);
  const folioPS = await siguienteFolio(tenantId);
  const notas = [
    `Venta pagada en línea (${texto(pago.proveedor, 30) || "pago en línea"} ${texto(pago.referencia, 120)}) el ${pagadoAt.toLocaleString("es-MX", { timeZone: "America/Mexico_City", dateStyle: "short", timeStyle: "short" })}`,
    `Total pagado: $${(monto + costoEnvio).toLocaleString("es-MX")} (producto $${monto.toLocaleString("es-MX")} + envío $${costoEnvio.toLocaleString("es-MX")}).`,
    comprobanteUrl ? `Comprobante de pago: ${comprobanteUrl}` : null,
  ].filter(Boolean).join("\n");

  const { lead, venta } = await prisma.$transaction(async (tx) => {
    const lead = await tx.lead.create({
      data: {
        folioPS,
        nombre: texto(cliente.nombre, 120),
        telefono: texto(cliente.telefono, 20),
        producto: principal.producto.nombre,
        categoria: principal.producto.categoria || "Health & Wellness",
        productoId: principal.producto.id,
        cantidad: piezas,
        folio,
        status: "VENTA",
        monto,
        notas,
        vendedorId: tienda.id,
        asignadoAt: new Date(),
        source: "EXTERNAL_API",
        origen: apiKey?.origen ?? null,
        country: "MX",
        state: texto(d.estado, 60),
        zipCode: cp,
        colonia,
        municipio,
        shippingStreet: texto(d.calle, 160),
        shippingNumber: texto(d.numero, 20) || null,
        shippingReferences: referencias,
        lat: Number.isFinite(Number(d.lat)) && d.lat !== null && d.lat !== "" ? Number(d.lat) : null,
        lng: Number.isFinite(Number(d.lng)) && d.lng !== null && d.lng !== "" ? Number(d.lng) : null,
        internalSku: principal.producto.sku,
        tenantId,
      },
    });
    for (const l of lineas) {
      await tx.leadItem.create({
        data: { leadId: lead.id, productoId: l.producto.id, cantidad: l.cantidad, precioUnitario: l.precioUnitario, esRegalo: l.esRegalo, tenantId },
      });
    }
    const venta = await tx.venta.create({
      data: {
        leadId: lead.id,
        vendedorId: tienda.id,
        monto,
        comision: 0,
        costoEnvio,
        folio,
        prepagada: true,
        sinComision: true,
        pagoProveedor: texto(pago.proveedor, 30) || null,
        pagoReferencia: texto(pago.referencia, 120),
        pagadoAt,
        comprobanteUrl,
        tenantId,
      },
    });
    // Mismo descuento de inventario que una venta cerrada por llamada (ganancias.js).
    for (const l of lineas) {
      const producto = await tx.producto.update({ where: { id: l.producto.id }, data: { stock: { decrement: l.cantidad } } });
      await tx.movimientoInventario.create({
        data: {
          productoId: l.producto.id, tipo: "SALIDA", cantidad: -l.cantidad, stockResultante: producto.stock,
          motivo: `Venta en línea #${folio}`, tenantId, ventaId: venta.id,
        },
      });
    }
    // Rastro del proveedor (igual que un lead por API): permite consultar por folio.
    await tx.incomingLead.create({
      data: {
        folio, consumerName: lead.nombre, phone: lead.telefono, country: "MX", state: lead.state, zipCode: cp,
        category: lead.categoria, product: lead.producto, internalSku: principal.producto.sku, externalSku: `BGW-${principal.producto.sku}`,
        buyerId: texto(body.buyerId, 120) || null, rawPayload: body, apiKeyId: apiKey.id, tenantId,
        status: "ASSIGNED", assignedLeadId: lead.id, assignedVendedorId: tienda.id,
      },
    });
    return { lead, venta };
  });

  // Sin municipio en el catálogo la orden sale con el hueco marcado ("POR
  // CONFIRMAR") en vez de quedarse sin enviar: el cliente ya pagó.
  await syncVentaToFullVector(venta.id, { completarFaltantes: !municipio });
  const final = await prisma.venta.findUnique({ where: { id: venta.id }, include: { lead: true } });
  return { ...respuesta(final, false), lead, tienda };
}

module.exports = { registrarVentaPrepagada, cuentaTiendaEnLinea, VentaPrepagadaError, TIENDA_NOMBRE };
