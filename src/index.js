require("dotenv").config();
const express = require("express");
const cors = require("cors");

// Intercepta todo console.error de la app (sin tocar cada ruta) para
// alimentar el módulo de monitoreo -- ver src/lib/errorLog.js. Debe
// registrarse antes de requerir las rutas, que son las que generan los
// console.error que queremos capturar.
const { captureError } = require("./lib/errorLog");
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  originalConsoleError(...args);
  captureError(args);
};

const { requestContextMiddleware } = require("./lib/requestContext");
const { auditMiddleware } = require("./lib/auditoria");
const { requestTimingMiddleware } = require("./lib/requestMetrics");
const monitoreoRoutes = require("./routes/monitoreo");
const { startMonitoringJob } = require("./jobs/monitoring");

const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const leadsRoutes = require("./routes/leads");
const llamadaRoutes = require("./routes/llamada");
const gananciasRoutes = require("./routes/ganancias");
const configuracionRoutes = require("./routes/configuracion");
const adminRoutes = require("./routes/admin");
const rolesRoutes = require("./routes/roles");
const apiKeysRoutes = require("./routes/apiKeys");
const externalRoutes = require("./routes/external");
const productosRoutes = require("./routes/productos");
const codigosPostalesRoutes = require("./routes/codigosPostales");
const inventarioRoutes = require("./routes/inventario");
const geocodeRoutes = require("./routes/geocode");
const coverageRoutes = require("./routes/coverage");
const superadminRoutes = require("./routes/superadmin");
const proveedorRoutes = require("./routes/proveedor");
const coordinadorRoutes = require("./routes/coordinador");
const voiceRoutes = require("./routes/voice");
const publicRoutes = require("./routes/public");
const brandingRoutes = require("./routes/branding");
const kardexRoutes = require("./routes/kardex");
const notificacionesRoutes = require("./routes/notificaciones");
const { startFullvectorRetryJob } = require("./jobs/fullvectorRetry");

const app = express();
const PORT = process.env.PORT || 3001;

// En multi-tenant el frontend se sirve desde varios hosts: el dominio de
// Railway, el dominio raiz (ej. beyond-goals.com / www) y un subdominio por
// cada empresa (ej. perfectself.beyond-goals.com). Un solo origin fijo
// bloqueaba por CORS cualquier request que no viniera exactamente de
// FRONTEND_URL -- incluido el login -- en cuanto una empresa tenia su propio
// subdominio.
// Orígenes adicionales permitidos (coma-separados) además de FRONTEND_URL y
// ROOT_DOMAIN -- para frontends standalone que no viven bajo el dominio
// principal (ej. sales-interface-perfectsales en su propio subdominio de
// Railway, mientras no tiene dominio propio).
const EXTRA_ALLOWED_ORIGINS = (process.env.EXTRA_ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / curl / server-to-server
  if (process.env.FRONTEND_URL && origin === process.env.FRONTEND_URL) return true;
  if (EXTRA_ALLOWED_ORIGINS.includes(origin)) return true;
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
app.use(requestContextMiddleware);
app.use(requestTimingMiddleware);
// Kardex: registra todo request que modifica algo (ver src/lib/auditoria.js).
// Va despues de requestContext para heredar el contexto del request, y antes
// de las rutas para alcanzar a enganchar el "finish" de cualquiera de ellas.
app.use(auditMiddleware);

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
app.use("/api/admin/roles", rolesRoutes);
app.use("/api/admin/monitoreo", monitoreoRoutes);
app.use("/api/admin/kardex", kardexRoutes);
app.use("/api/admin/notificaciones", notificacionesRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/external", externalRoutes);
app.use("/api/productos", productosRoutes);
app.use("/api/codigos-postales", codigosPostalesRoutes);
app.use("/api/geocode", geocodeRoutes);
app.use("/api/coverage", coverageRoutes);
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
  startFullvectorRetryJob();
  startMonitoringJob();
});
