// Rutas que comparten el ADMIN (dueño del espacio) y el ADMIN_OPERATIVO.
//
// La diferencia entre los dos NO se resuelve con el catalogo de permisos:
// RolePermiso guarda por rol y empresa, no por usuario, asi que apagarle
// "Ver API" a uno se lo apagaria a todos. Y las claves admin.vista.* solo
// esconden el menu -- `requirePermiso` no se usa en ninguna ruta de admin --
// de modo que esconder la pestaña no impedia llamar al endpoint a mano.
//
// Por eso la frontera es el rol, que si se valida aqui, en el servidor:
//
//   adminMiddleware   -> solo ADMIN. Equipo, API keys, parametros, roles,
//                        marca, kardex, monitoreo, grabaciones, payloads.
//   gestionAdmin      -> ADMIN y ADMIN_OPERATIVO. Tablero, leads, ventas,
//                        inventario, historial, prepago, comisiones.
const ROLES_GESTION = ["ADMIN", "ADMIN_OPERATIVO"];

function gestionAdminMiddleware(req, res, next) {
  if (!ROLES_GESTION.includes(req.user?.rol)) {
    return res.status(403).json({ error: "Acceso restringido a administradores" });
  }
  next();
}

module.exports = gestionAdminMiddleware;
module.exports.ROLES_GESTION = ROLES_GESTION;
