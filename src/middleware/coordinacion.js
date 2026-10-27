// Las vistas de coordinación (historial, progreso, reparto de leads) las usa
// la coordinadora y también los dos administradores, que están por encima
// de ella: con el
// middleware de coordinador a secas, un administrador recibía 403 y no podía
// ni generar los reportes del historial.
const ROLES = ["COORDINADOR", "ADMIN", "ADMIN_OPERATIVO"];

function coordinacionMiddleware(req, res, next) {
  if (!ROLES.includes(req.user?.rol)) {
    return res.status(403).json({ error: "Acceso restringido a coordinación y administración" });
  }
  next();
}

module.exports = coordinacionMiddleware;
