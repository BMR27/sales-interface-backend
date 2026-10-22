const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const BASE_URL = process.env.FULLVECTOR_API_URL;
const SERVICE_EMAIL = process.env.FULLVECTOR_SERVICE_EMAIL;
const SERVICE_PASSWORD = process.env.FULLVECTOR_SERVICE_PASSWORD;
const CLIENT_CODE = process.env.FULLVECTOR_CLIENT_CODE || "CL1";

const MAX_ATTEMPTS = 10;

// Error permanente: el payload nunca va a ser aceptado por FullVector tal
// como está (dirección incompleta, SKU inexistente, etc.). No tiene sentido
// reintentarlo -- se marca FAILED directo en vez de dejarlo PENDING.
class PermanentSyncError extends Error {}

function isEnabled() {
  return Boolean(BASE_URL && SERVICE_EMAIL && SERVICE_PASSWORD);
}

let cachedToken = null;

async function login() {
  const resp = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: SERVICE_EMAIL, password: SERVICE_PASSWORD }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body?.data?.token) {
    throw new Error(`FullVector login falló (${resp.status}): ${body?.error?.message || ""}`);
  }
  cachedToken = body.data.token;
  return cachedToken;
}

async function authedFetch(path, options) {
  if (!cachedToken) await login();
  let resp = await doFetch(path, options, cachedToken);
  if (resp.status === 401) {
    cachedToken = null;
    await login();
    resp = await doFetch(path, options, cachedToken);
  }
  return resp;
}

function doFetch(path, options, token) {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
}

// Mismo criterio de fallback que ya usa ganancias.js para el descuento de
// stock: si la venta tiene LeadItem[] se usan esos renglones; si no, se
// arma un único item con los datos sueltos del lead.
function buildItems(lead, leadItems, productos, productoCatalogo) {
  if (leadItems.length > 0) {
    const productosById = new Map(productos.map((p) => [p.id, p]));
    // Un mismo producto puede aparecer en más de un LeadItem (ej. piezas
    // pagadas + piezas de regalo, ver active-call-panel.tsx) -- se fusionan
    // por SKU para que el mensajero vea una sola línea con la cantidad
    // total en vez de dos renglones separados del mismo producto.
    const porSku = new Map();
    for (const item of leadItems) {
      const producto = productosById.get(item.productoId);
      const sku = producto?.sku;
      const name = producto?.nombre || producto?.producto || lead.producto;
      const existing = porSku.get(sku);
      if (existing) existing.quantity += item.cantidad;
      else porSku.set(sku, { name, quantity: item.cantidad, sku });
    }
    return Array.from(porSku.values());
  }
  // Mismo fallback que ganancias.js usa para el descuento de stock: sin
  // LeadItem[], el SKU sale del Producto vinculado por productoId (fuente
  // viva y correcta del catálogo actual). lead.internalSku sólo se usa como
  // último recurso para leads sin productoId (ej. EXTERNAL_API) -- es un
  // valor suelto capturado al crear el lead y puede quedar desactualizado
  // si el catálogo cambia después (visto en producción: un lead con
  // productoId apuntando a un producto cuyo SKU ya no coincide con el
  // internalSku guardado).
  return [
    {
      name: lead.producto,
      quantity: lead.cantidad || 1,
      sku: productoCatalogo?.sku || lead.internalSku,
    },
  ];
}

// Valor con el que se rellena un campo de domicilio que el lead no trae,
// cuando se fuerza el envio de una venta vieja (ver
// scripts/resync-fullvector-fallidas.js). Es visible a proposito: quien
// opere la orden en FullVector tiene que ver que ese dato falta y
// confirmarlo por telefono antes de mandar el paquete.
const DATO_FALTANTE = "POR CONFIRMAR";

function buildOrderPayload(lead, venta, leadItems, productos, productoCatalogo, options = {}) {
  const faltantes = ["shippingStreet", "shippingNumber", "colonia", "municipio", "state", "zipCode", "telefono"]
    .filter((campo) => !lead[campo]);
  // `completarFaltantes` es la excepcion puntual: en vez de rechazar la
  // venta, se manda con los huecos marcados. Sin la bandera, el
  // comportamiento de siempre -- una direccion incompleta no se envia.
  if (faltantes.length > 0 && !options.completarFaltantes) {
    throw new PermanentSyncError("Dirección de envío incompleta en el lead, no se puede crear la orden en FullVector");
  }
  // El CP es lo unico que no se puede inventar: FullVector resuelve
  // cobertura y equipo con el, y un CP falso mandaria la orden al equipo
  // equivocado en vez de a la base de prepago.
  if (!lead.zipCode) {
    throw new PermanentSyncError("El lead no tiene código postal, no se puede crear la orden en FullVector");
  }

  const items = buildItems(lead, leadItems, productos, productoCatalogo);
  if (items.some((item) => !item.sku)) {
    throw new PermanentSyncError("Falta el SKU de uno o más productos para crear la orden en FullVector");
  }

  return {
    clientCode: CLIENT_CODE,
    orderNumber: venta.folio,
    // orderValue es lo que el mensajero cobra contra-entrega (COD) --
    // incluye el costo de envío, a diferencia de `venta.monto` (solo
    // producto, base de la comisión del vendedor).
    orderValue: venta.monto + (venta.costoEnvio || 0),
    address: {
      recipientName: `${lead.nombre} ${lead.apellido || ""}`.trim() || DATO_FALTANTE,
      phone: lead.telefono || DATO_FALTANTE,
      street: lead.shippingStreet || DATO_FALTANTE,
      extNumber: lead.shippingNumber || DATO_FALTANTE,
      postalCode: lead.zipCode,
      neighborhood: lead.colonia || DATO_FALTANTE,
      municipality: lead.municipio || DATO_FALTANTE,
      state: lead.state || DATO_FALTANTE,
      ...(lead.lat != null ? { latitude: lead.lat } : {}),
      ...(lead.lng != null ? { longitude: lead.lng } : {}),
    },
    items,
  };
}

// OUT_OF_COVERAGE ya no aparece aqui: FullVector dejo de rechazar los CP
// fuera de cobertura y ahora crea la orden con trackingStatus NO_COVERAGE
// (ver createOrder en dynamic-system-design). Esas ventas se marcan
// `fullvectorSinCobertura` para gestionarlas como prepago.
const PERMANENT_ERROR_CODES = [
  "CLIENT_NOT_FOUND",
  "PRODUCT_NOT_FOUND",
  "VALIDATION_ERROR",
  "FORBIDDEN",
];

// Recupera el id de FullVector de una orden que ya existe alla (folio
// duplicado): sin esto, una venta marcada SYNCED por un 409 se quedaba sin
// id y no habia forma de cruzarla.
async function buscarOrdenPorFolio(folio) {
  const resp = await authedFetch(`/api/v1/orders/search?orderNumber=${encodeURIComponent(folio)}`, {
    method: "GET",
  });
  if (!resp.ok) return null;
  const body = await resp.json().catch(() => ({}));
  const match = (body?.data || []).find((o) => o.orden === folio);
  return match ? { orderId: match.id, trackingStatus: match.estatus } : null;
}

async function createOrderInFullVector(payload) {
  const resp = await authedFetch("/api/v1/orders", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (resp.status === 201 || resp.status === 200) {
    const body = await resp.json();
    // trackingStatus NO_COVERAGE = FullVector la acepto pero el CP esta
    // fuera de su cobertura: no hay pago en efectivo contra entrega, se
    // gestiona como prepago (transferencia + mensajeria tradicional).
    return { orderId: body?.data?.id || null, trackingStatus: body?.data?.trackingStatus || null };
  }
  if (resp.status === 409) {
    // DuplicateOrderError: ya se había sincronizado en un intento anterior.
    return (await buscarOrdenPorFolio(payload.orderNumber)) || { orderId: null, trackingStatus: null };
  }

  const body = await resp.json().catch(() => ({}));
  if (PERMANENT_ERROR_CODES.includes(body?.error?.code)) {
    throw new PermanentSyncError(body?.error?.message || `Error permanente ${resp.status}`);
  }
  throw new Error(`FullVector respondió ${resp.status}: ${body?.error?.message || ""}`);
}

// Abre (una sola vez) el expediente de prepago de una venta sin cobertura y
// manda el aviso. Si el expediente ya existía no se vuelve a notificar: un
// reintento de sincronización no debe repetir el correo.
async function abrirGestionPrepago(venta, lead) {
  try {
    const existente = await prisma.prepagoGestion.findUnique({ where: { ventaId: venta.id } });
    if (existente) return;

    await prisma.prepagoGestion.create({
      data: { ventaId: venta.id, tenantId: venta.tenantId },
    });

    const vendedor = await prisma.user.findUnique({
      where: { id: venta.vendedorId },
      select: { nombre: true, email: true },
    });
    const { notificarVentaSinCobertura } = require("./notificaciones");
    await notificarVentaSinCobertura(venta, lead, { vendedor });
  } catch (err) {
    console.error("no se pudo abrir la gestion de prepago de la venta", venta?.id, err);
  }
}

async function syncVentaToFullVector(ventaId, options = {}) {
  if (!isEnabled()) return;

  const venta = await prisma.venta.findUnique({ where: { id: ventaId } });
  if (!venta || venta.fullvectorSyncStatus === "SYNCED") return;

  try {
    const lead = await prisma.lead.findUnique({ where: { id: venta.leadId } });
    const leadItems = await prisma.leadItem.findMany({ where: { leadId: venta.leadId } });
    const productos = leadItems.length
      ? await prisma.producto.findMany({ where: { id: { in: leadItems.map((i) => i.productoId) } } })
      : [];
    const productoCatalogo = !leadItems.length && lead.productoId
      ? await prisma.producto.findUnique({ where: { id: lead.productoId } })
      : null;

    const payload = buildOrderPayload(lead, venta, leadItems, productos, productoCatalogo, options);
    const { orderId, trackingStatus } = await createOrderInFullVector(payload);

    const sinCobertura = trackingStatus === "NO_COVERAGE";
    const actualizada = await prisma.venta.update({
      where: { id: venta.id },
      data: {
        fullvectorSyncStatus: "SYNCED",
        fullvectorOrderId: orderId,
        fullvectorSinCobertura: sinCobertura,
        fullvectorError: null,
        fullvectorSyncedAt: new Date(),
      },
    });

    // Sin cobertura no hay pago contra entrega: se abre el expediente de
    // prepago y se avisa por correo a quien cobra. Ambas cosas son idempotentes
    // y no deben tumbar la sincronización, que ya quedó guardada arriba.
    if (sinCobertura) await abrirGestionPrepago(actualizada, lead);
  } catch (err) {
    const attempts = venta.fullvectorAttempts + 1;
    const permanente = err instanceof PermanentSyncError || attempts >= MAX_ATTEMPTS;
    await prisma.venta.update({
      where: { id: venta.id },
      data: {
        fullvectorSyncStatus: permanente ? "FAILED" : "PENDING",
        fullvectorError: String(err.message || err).slice(0, 500),
        fullvectorAttempts: attempts,
      },
    });
  }
}

// Consulta si un CP/colonia está cubierto por FullVector -- usado para
// decidir el costo de envío (ver src/lib/shippingCost.js). Devuelve null
// (no true/false) cuando no se pudo verificar, para que el llamador no
// castigue al cliente con el cargo de "fuera de cobertura" por una falla
// técnica transitoria.
async function checkCoverage(postalCode, neighborhood) {
  if (!isEnabled() || !postalCode) return null;
  try {
    const qs = new URLSearchParams({ postalCode, ...(neighborhood ? { neighborhood } : {}) });
    const resp = await authedFetch(`/api/v1/coverage/check?${qs.toString()}`, { method: "GET" });
    if (!resp.ok) return null;
    const body = await resp.json();
    return typeof body?.data?.covered === "boolean" ? body.data.covered : null;
  } catch (err) {
    console.error("fullvector checkCoverage error", err);
    return null;
  }
}

module.exports = {
  isEnabled,
  syncVentaToFullVector,
  buscarOrdenPorFolio,
  checkCoverage,
  PermanentSyncError,
};
