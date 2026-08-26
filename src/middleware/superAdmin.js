function superAdminMiddleware(req, res, next) {
  if (req.user?.rol !== "SUPER_ADMIN") {
    return res.status(403).json({ error: "Acceso restringido a super administradores" });
  }
  next();
}

module.exports = superAdminMiddleware;
