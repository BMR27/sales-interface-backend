const { flushBufferedErrors } = require("./errorLog");

// Acumulador en memoria de tiempos de respuesta, agrupado por ruta
// normalizada + método. Se llena en cada request (barato, sólo suma a un
// objeto) y se vacía a la tabla RequestMetric cada 5 min desde
// src/jobs/monitoring.js -- escribir a DB en cada request sería carísimo.
let buckets = new Map();

function key(route, method) {
  return `${method} ${route}`;
}

function recordDuration(route, method, durationMs, isError) {
  const k = key(route, method);
  const entry = buckets.get(k) || { route, method, count: 0, totalDurationMs: 0, maxDurationMs: 0, errorCount: 0 };
  entry.count += 1;
  entry.totalDurationMs += durationMs;
  entry.maxDurationMs = Math.max(entry.maxDurationMs, durationMs);
  if (isError) entry.errorCount += 1;
  buckets.set(k, entry);
}

// Devuelve lo acumulado hasta ahora y resetea el acumulador -- pensado
// para llamarse una sola vez por tick del job periódico.
function drainBuckets() {
  const drained = Array.from(buckets.values());
  buckets = new Map();
  return drained;
}

function requestTimingMiddleware(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    // req.route?.path trae el patrón con params (ej. "/:id") cuando Express
    // lo resolvió; si no, cae a la ruta cruda para no perder el dato.
    const route = req.baseUrl + (req.route?.path && req.route.path !== "/" ? req.route.path : "");
    recordDuration(route || req.path, req.method, Date.now() - start, res.statusCode >= 500);
    flushBufferedErrors(res.statusCode);
  });
  next();
}

module.exports = { requestTimingMiddleware, drainBuckets };
