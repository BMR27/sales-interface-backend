function proveedorMiddleware(req, res, next) {
  if (req.user?.rol !== "PROVEEDOR_LEADS") {
    return res.status(403).json({ error: "Acceso restringido a proveedores de leads" });
  }
  next();
}

module.exports = proveedorMiddleware;
