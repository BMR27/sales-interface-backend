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
const coordinadorRoutes = require("./routes/coordinador");
const voiceRoutes = require("./routes/voice");
const publicRoutes = require("./routes/public");
const brandingRoutes = require("./routes/branding");

const app = express();
const PORT = process.env.PORT || 3001;

// En multi-tenant el frontend se sirve desde varios hosts: el dominio de
// Railway, el dominio raiz (ej. beyond-goals.com / www) y un subdominio por
// cada empresa (ej. perfectself.beyond-goals.com). Un solo origin fijo
// bloqueaba por CORS cualquier request que no viniera exactamente de
// FRONTEND_URL -- incluido el login -- en cuanto una empresa tenia su propio
// subdominio.
function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / curl / server-to-server
  if (process.env.FRONTEND_URL && origin === process.env.FRONTEND_URL) return true;
  if (process.env.ROOT_DOMAIN) {
    try {
      const { hostname } = new URL(origin);
      if (hostname === process.env.ROOT_DOMAIN || hostname.endsWith(`.${process.env.ROOT_DOMAIN}`)) {
        return true;
      }
    } catch {
      // origin malformado, lo rechaza abajo
    }
  }
  return false;
}

app.use(cors({
  origin: (origin, callback) => {
    if (!process.env.FRONTEND_URL && !process.env.ROOT_DOMAIN) return callback(null, true);
    if (isAllowedOrigin(origin)) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio postea los webhooks form-encoded

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
app.use("/api/admin/branding", brandingRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/external", externalRoutes);
app.use("/api/productos", productosRoutes);
app.use("/api/codigos-postales", codigosPostalesRoutes);
app.use("/api/geocode", geocodeRoutes);
app.use("/api/superadmin", superadminRoutes);
app.use("/api/proveedor", proveedorRoutes);
app.use("/api/coordinador", coordinadorRoutes);
app.use("/api/voice", voiceRoutes);
app.use("/api/public", publicRoutes);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Error interno del servidor" });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
