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

function buildOrderPayload(lead, venta, leadItems, productos, productoCatalogo) {
  const direccionIncompleta =
    !lead.shippingStreet ||
    !lead.shippingNumber ||
    !lead.colonia ||
    !lead.municipio ||
    !lead.state ||
    !lead.zipCode ||
    !lead.telefono;
  if (direccionIncompleta) {
    throw new PermanentSyncError("Dirección de envío incompleta en el lead, no se puede crear la orden en FullVector");
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
      recipientName: `${lead.nombre} ${lead.apellido || ""}`.trim(),
      phone: lead.telefono,
      street: lead.shippingStreet,
      extNumber: lead.shippingNumber,
      postalCode: lead.zipCode,
      neighborhood: lead.colonia,
      municipality: lead.municipio,
      state: lead.state,
      ...(lead.lat != null ? { latitude: lead.lat } : {}),
      ...(lead.lng != null ? { longitude: lead.lng } : {}),
    },
    items,
  };
}

const PERMANENT_ERROR_CODES = [
  "CLIENT_NOT_FOUND",
  "PRODUCT_NOT_FOUND",
  "VALIDATION_ERROR",
  "OUT_OF_COVERAGE",
  "FORBIDDEN",
];

async function createOrderInFullVector(payload) {
  const resp = await authedFetch("/api/v1/orders", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (resp.status === 201 || resp.status === 200) {
    const body = await resp.json();
    return { orderId: body?.data?.id || null };
  }
  if (resp.status === 409) {
    // DuplicateOrderError: ya se había sincronizado en un intento anterior.
    return { orderId: null };
  }

  const body = await resp.json().catch(() => ({}));
  if (PERMANENT_ERROR_CODES.includes(body?.error?.code)) {
    throw new PermanentSyncError(body?.error?.message || `Error permanente ${resp.status}`);
  }
  throw new Error(`FullVector respondió ${resp.status}: ${body?.error?.message || ""}`);
}

async function syncVentaToFullVector(ventaId) {
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

    const payload = buildOrderPayload(lead, venta, leadItems, productos, productoCatalogo);
    const { orderId } = await createOrderInFullVector(payload);

    await prisma.venta.update({
      where: { id: venta.id },
      data: {
        fullvectorSyncStatus: "SYNCED",
        fullvectorOrderId: orderId,
        fullvectorError: null,
        fullvectorSyncedAt: new Date(),
      },
    });
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
  checkCoverage,
  PermanentSyncError,
};
