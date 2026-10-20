const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Campos que nunca deben quedar escritos en el kardex, venga de donde venga
// el request. Se filtran por nombre en cualquier nivel del objeto.
const CAMPOS_SENSIBLES = new Set([
  "password",
  "passwordNuevo",
  "passwordActual",
  "token",
  "key",
  "keyHash",
  "apiKey",
  "authorization",
]);

function sanitizar(valor, profundidad = 0) {
  if (valor == null || profundidad > 4) return valor ?? null;
  // Las fechas son objetos sin claves propias: sin esto quedaban como {}.
  if (valor instanceof Date) return valor.toISOString();
  if (Array.isArray(valor)) return valor.slice(0, 50).map((v) => sanitizar(v, profundidad + 1));
  if (typeof valor === "object") {
    const salida = {};
    for (const [k, v] of Object.entries(valor)) {
      salida[k] = CAMPOS_SENSIBLES.has(k) ? "***" : sanitizar(v, profundidad + 1);
    }
    return salida;
  }
  if (typeof valor === "string" && valor.length > 1000) return valor.slice(0, 1000) + "…";
  return valor;
}

// Diferencia campo a campo entre dos estados, para que el detalle del
// movimiento diga "status: NUEVO -> VENTA" en vez de obligar a comparar dos
// objetos completos a ojo.
function calcularCambios(antes, despues) {
  if (!antes || !despues) return null;
  const cambios = {};
  for (const clave of new Set([...Object.keys(antes), ...Object.keys(despues)])) {
    const a = antes[clave];
    const d = despues[clave];
    if (JSON.stringify(a) !== JSON.stringify(d)) cambios[clave] = { antes: a ?? null, despues: d ?? null };
  }
  return Object.keys(cambios).length > 0 ? cambios : null;
}

// Catálogo de movimientos: traduce método + ruta a algo que un humano pueda
// leer en el kardex. La llave es "METODO /ruta/normalizada"; :param hace
// match con cualquier segmento.
const CATALOGO = [
  ["POST /api/auth/login", "sesion.iniciar", "Sesión", "Inició sesión"],
  ["POST /api/auth/registro", "usuario.registrar", "Usuario", "Se registró en la plataforma"],
  ["POST /api/leads", "lead.crear", "Lead", "Creó un lead"],
  ["PUT /api/leads/:id", "lead.editar", "Lead", "Editó un lead"],
  ["DELETE /api/leads/:id", "lead.descartar", "Lead", "Descartó un lead"],
  ["POST /api/leads/:id/ticket-sms", "lead.ticket_sms", "Lead", "Envió el ticket por SMS"],
  ["POST /api/leads/:id/solicitar-ubicacion", "lead.solicitar_ubicacion", "Lead", "Pidió la ubicación al cliente por SMS"],
  ["POST /api/llamada/:id/confirmar", "llamada.confirmar", "Llamada", "Registró el resultado de una llamada"],
  ["POST /api/llamada/:id/reagendar", "llamada.reagendar", "Llamada", "Reagendó una llamada (Re-Llamar)"],
  ["POST /api/ganancias/venta", "venta.registrar", "Venta", "Registró una venta"],
  ["POST /api/admin/leads/bulk", "lead.importar", "Lead", "Importó leads en lote"],
  ["PUT /api/admin/leads/:id/asignar", "lead.reasignar", "Lead", "Reasignó un lead a otra vendedora"],
  ["POST /api/admin/usuarios", "usuario.crear", "Usuario", "Dio de alta a un usuario"],
  ["PUT /api/admin/usuarios/:id", "usuario.editar", "Usuario", "Editó a un usuario"],
  ["POST /api/admin/invitacion", "invitacion.generar", "Invitación", "Generó un link de invitación"],
  ["POST /api/admin/api-keys", "api_key.crear", "API Key", "Generó una API key"],
  ["DELETE /api/admin/api-keys/:id", "api_key.revocar", "API Key", "Revocó una API key"],
  ["DELETE /api/admin/api-keys/:id/permanente", "api_key.eliminar", "API Key", "Eliminó una API key"],
  ["POST /api/admin/inventario/movimiento", "inventario.movimiento", "Inventario", "Registró un movimiento de inventario"],
  ["PUT /api/admin/branding", "branding.editar", "Marca", "Cambió la marca del espacio"],
  ["PUT /api/admin/roles/:rol", "permisos.editar", "Permisos", "Cambió los permisos de un rol"],
  ["PUT /api/admin/notificaciones", "notificaciones.editar", "Notificaciones", "Cambió las notificaciones por correo"],
  ["POST /api/admin/notificaciones/prueba", "notificaciones.prueba", "Notificaciones", "Envió un correo de prueba"],
  ["POST /api/coordinador/leads/asignar", "lead.asignar", "Lead", "Asignó leads a una vendedora"],
  ["PUT /api/configuracion", "perfil.editar", "Perfil", "Editó su perfil"],
  ["POST /api/external/leads", "lead.crear_api", "Lead", "Lead recibido por la API del proveedor"],
  ["POST /api/external/entregas", "entrega.confirmar", "Venta", "Confirmación de entrega desde FullVector"],
];

// Movimientos que no nacen de una ruta (los registra el código a mano), pero
// que igual necesitan una etiqueta legible en los filtros del kardex.
const ETIQUETAS_EXTRA = {
  "sesion.fallida": "Intento de sesión fallido",
};

const ETIQUETAS = {
  ...Object.fromEntries(CATALOGO.map(([, accion, , descripcion]) => [accion, descripcion])),
  ...ETIQUETAS_EXTRA,
};

function rutaCoincide(patron, ruta) {
  const p = patron.split("/");
  const r = ruta.split("/");
  if (p.length !== r.length) return false;
  return p.every((seg, i) => seg.startsWith(":") || seg === r[i]);
}

function describirMovimiento(metodo, ruta) {
  const limpia = ruta.split("?")[0].replace(/\/$/, "") || "/";
  for (const [patron, accion, entidad, descripcion] of CATALOGO) {
    const [m, p] = patron.split(" ");
    if (m === metodo && rutaCoincide(p, limpia)) return { accion, entidad, descripcion };
  }
  return null;
}

function ipDeRequest(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

// Escribe una fila del kardex. Nunca lanza: un fallo registrando la bitácora
// no puede tumbar la operación que la originó.
async function registrar(entrada) {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: entrada.tenantId ?? null,
        userId: entrada.userId ?? null,
        userNombre: entrada.userNombre ?? null,
        userEmail: entrada.userEmail ?? null,
        userRol: entrada.userRol ?? null,
        accion: entrada.accion,
        entidad: entrada.entidad ?? null,
        entidadId: entrada.entidadId != null ? String(entrada.entidadId) : null,
        descripcion: entrada.descripcion,
        antes: entrada.antes ? sanitizar(entrada.antes) : undefined,
        despues: entrada.despues ? sanitizar(entrada.despues) : undefined,
        cambios: entrada.cambios ? sanitizar(entrada.cambios) : undefined,
        origen: entrada.origen || "web",
        metodo: entrada.metodo ?? null,
        ruta: entrada.ruta ?? null,
        statusCode: entrada.statusCode ?? null,
        ip: entrada.ip ?? null,
        userAgent: entrada.userAgent ? String(entrada.userAgent).slice(0, 300) : null,
      },
    });
  } catch {
    // intencional: no-op. Igual que errorLog, la bitácora nunca estorba.
  }
}

// Permite a una ruta enriquecer el movimiento que el middleware va a escribir
// (el nombre del lead, el folio, el estado anterior...). La ruta no escribe
// nada: deja el detalle en req y el middleware lo recoge al terminar.
function detallarMovimiento(req, detalle) {
  req._auditoria = { ...(req._auditoria || {}), ...detalle };
}

// Middleware global: cada request que modifica algo y termina bien queda
// registrado, sin tener que instrumentar ruta por ruta -- el mismo enfoque
// que usa el módulo de monitoreo con console.error.
function auditMiddleware(req, res, next) {
  if (req.method === "GET" || req.method === "OPTIONS" || req.method === "HEAD") return next();

  res.on("finish", () => {
    if (res.statusCode >= 400) return;

    const base = describirMovimiento(req.method, req.originalUrl || req.path);
    const extra = req._auditoria || {};
    if (!base && !extra.accion) return; // request que no representa un movimiento del negocio

    // El usuario puede venir de un token (web) o de una API key (proveedor).
    const usuario = req.user || {};
    const porApiKey = Boolean(req.apiKey);

    registrar({
      tenantId: extra.tenantId ?? usuario.tenantId ?? req.apiKey?.tenantId ?? null,
      userId: usuario.id ?? extra.userId ?? null,
      userNombre: extra.userNombre ?? usuario.nombre ?? (porApiKey ? `API key ${req.apiKey.keyPrefix}…` : null),
      userEmail: extra.userEmail ?? usuario.email ?? null,
      userRol: usuario.rol ?? (porApiKey ? "PROVEEDOR_LEADS" : null),
      accion: extra.accion ?? base.accion,
      entidad: extra.entidad ?? base?.entidad,
      entidadId: extra.entidadId ?? req.params?.id ?? null,
      descripcion: extra.descripcion ?? base.descripcion,
      antes: extra.antes,
      despues: extra.despues ?? (Object.keys(req.body || {}).length > 0 ? req.body : undefined),
      cambios: extra.cambios ?? calcularCambios(extra.antes, extra.despues),
      origen: porApiKey ? "api_externa" : "web",
      metodo: req.method,
      ruta: (req.originalUrl || req.path).split("?")[0],
      statusCode: res.statusCode,
      ip: ipDeRequest(req),
      userAgent: req.headers["user-agent"],
    });
  });

  next();
}

module.exports = {
  auditMiddleware,
  registrar,
  detallarMovimiento,
  calcularCambios,
  sanitizar,
  CATALOGO,
  ETIQUETAS,
};
