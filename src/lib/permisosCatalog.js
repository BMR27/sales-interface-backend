const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Catalogo de permisos configurables por rol, agrupados para la UI de
// Configuracion > Roles y Permisos. Agregar un permiso nuevo es solo
// agregar una linea aqui -- no requiere tocar el modelo de datos.
// SUPER_ADMIN y PROVEEDOR_LEADS quedan fuera: el superadmin es nivel
// plataforma y el proveedor tiene una sola pantalla trivial.
const PERMISOS_CATALOG = {
  VENDEDOR: [
    { clave: "vendedor.vista.catalogo", tipo: "modulo", grupo: "Navegacion", label: "Ver Catalogo" },
    { clave: "vendedor.leads.rechazar", tipo: "accion", grupo: "Leads", label: "Descartar leads" },
    { clave: "vendedor.leads.devolver", tipo: "accion", grupo: "Leads", label: "Devolver leads a la cola de asignacion" },
    { clave: "vendedor.leads.reagendar", tipo: "accion", grupo: "Leads", label: "Re-Llamar (reagendar llamadas)" },
    { clave: "vendedor.leads.confirmar_venta", tipo: "accion", grupo: "Leads", label: "Confirmar ventas" },
    { clave: "vendedor.leads.agregar_producto", tipo: "accion", grupo: "Leads", label: "Agregar productos extra al carrito" },
  ],
  COORDINADOR: [
    { clave: "coordinador.vista.progreso", tipo: "modulo", grupo: "Navegacion", label: "Ver Progreso del equipo" },
    { clave: "coordinador.vista.historial", tipo: "modulo", grupo: "Navegacion", label: "Ver Historial" },
    { clave: "coordinador.vista.catalogo", tipo: "modulo", grupo: "Navegacion", label: "Ver Catalogo" },
  ],
  ADMIN: [
    { clave: "admin.vista.inventario", tipo: "modulo", grupo: "Navegacion", label: "Ver Inventario" },
    { clave: "admin.vista.api", tipo: "modulo", grupo: "Navegacion", label: "Ver API" },
    { clave: "admin.vista.marca", tipo: "modulo", grupo: "Navegacion", label: "Ver Marca" },
    { clave: "admin.vista.monitoreo", tipo: "modulo", grupo: "Navegacion", label: "Ver Monitoreo" },
    { clave: "admin.vista.kardex", tipo: "modulo", grupo: "Navegacion", label: "Ver Kardex (bitacora del sistema)" },
    { clave: "admin.vista.grabaciones", tipo: "modulo", grupo: "Navegacion", label: "Escuchar grabaciones de llamadas" },
    { clave: "admin.equipo.editar", tipo: "accion", grupo: "Equipo", label: "Editar equipo (altas/bajas)" },
  ],
};

const ROLES_CONFIGURABLES = Object.keys(PERMISOS_CATALOG);

function clavesValidas(rol) {
  return new Set((PERMISOS_CATALOG[rol] || []).map((p) => p.clave));
}

// Mapa { clave: boolean } para un rol dentro de un tenant. Todo lo que no
// tenga fila en BD se considera permitido (default-allow).
async function getPermisosEfectivos(tenantId, rol) {
  const catalogo = PERMISOS_CATALOG[rol] || [];
  const permisos = {};
  for (const item of catalogo) permisos[item.clave] = true;

  if (!tenantId || catalogo.length === 0) return permisos;

  const filas = await prisma.rolePermiso.findMany({ where: { tenantId, rol } });
  for (const fila of filas) {
    if (fila.clave in permisos) permisos[fila.clave] = fila.activo;
  }
  return permisos;
}

// Middleware para proteger una accion puntual con una clave de permiso.
// Deja pasar si el usuario no tiene tenant (p.ej. SUPER_ADMIN) o si la
// clave esta activa; responde 403 si esta desactivada explicitamente.
function requirePermiso(clave) {
  return async function (req, res, next) {
    try {
      if (!req.user?.tenantId) return next();
      const permisos = await getPermisosEfectivos(req.user.tenantId, req.user.rol);
      if (clave in permisos && permisos[clave] === false) {
        return res.status(403).json({ error: "No tienes permiso para realizar esta accion" });
      }
      next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error del servidor" });
    }
  };
}

module.exports = {
  PERMISOS_CATALOG,
  ROLES_CONFIGURABLES,
  clavesValidas,
  getPermisosEfectivos,
  requirePermiso,
};
