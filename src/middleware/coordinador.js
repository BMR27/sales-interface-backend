function coordinadorMiddleware(req, res, next) {
  if (req.user?.rol !== "COORDINADOR") {
    return res.status(403).json({ error: "Acceso restringido a coordinadores" });
  }
  next();
}

module.exports = coordinadorMiddleware;
