require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const leadsRoutes = require("./routes/leads");
const llamadaRoutes = require("./routes/llamada");
const gananciasRoutes = require("./routes/ganancias");
const configuracionRoutes = require("./routes/configuracion");
const adminRoutes = require("./routes/admin");
const apiKeysRoutes = require("./routes/apiKeys");
const externalRoutes = require("./routes/external");
const productosRoutes = require("./routes/productos");
const codigosPostalesRoutes = require("./routes/codigosPostales");
const inventarioRoutes = require("./routes/inventario");
const geocodeRoutes = require("./routes/geocode");
const superadminRoutes = require("./routes/superadmin");
const proveedorRoutes = require("./routes/proveedor");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  credentials: true,
}));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/leads", leadsRoutes);
app.use("/api/llamada", llamadaRoutes);
app.use("/api/ganancias", gananciasRoutes);
app.use("/api/configuracion", configuracionRoutes);
app.use("/api/admin/api-keys", apiKeysRoutes);
app.use("/api/admin/inventario", inventarioRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/external", externalRoutes);
app.use("/api/productos", productosRoutes);
app.use("/api/codigos-postales", codigosPostalesRoutes);
app.use("/api/geocode", geocodeRoutes);
app.use("/api/superadmin", superadminRoutes);
app.use("/api/proveedor", proveedorRoutes);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Error interno del servidor" });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
