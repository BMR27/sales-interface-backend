// Las vistas de coordinación (historial, progreso, reparto de leads) las usa
// la coordinadora y también el ADMIN, que está por encima de ella: con el
// middleware de coordinador a secas, un administrador recibía 403 y no podía
// ni generar los reportes del historial.
function coordinacionMiddleware(req, res, next) {
  if (req.user?.rol !== "COORDINADOR" && req.user?.rol !== "ADMIN") {
    return res.status(403).json({ error: "Acceso restringido a coordinación y administración" });
  }
  next();
}

module.exports = coordinacionMiddleware;
