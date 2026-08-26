function adminMiddleware(req, res, next) {
  if (req.user?.rol !== "ADMIN") {
    return res.status(403).json({ error: "Acceso restringido a administradores" });
  }
  next();
}

module.exports = adminMiddleware;
