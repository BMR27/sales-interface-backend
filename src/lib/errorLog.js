const { PrismaClient } = require("@prisma/client");
const { getRequestContext, bufferError, takeBufferedErrors } = require("./requestContext");

const prisma = new PrismaClient();

function pickErrorAndMessage(args) {
  const err = args.find((a) => a instanceof Error);
  const message = args
    .map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a)))
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);
  return { err, message: message || "(sin mensaje)" };
}

function persist(entry) {
  return prisma.errorLog.create({ data: entry }).catch(() => {
    // intencional: no-op, nunca debe volver a llamar console.error (recursión)
  });
}

// Llamado desde el console.error interceptado en src/index.js. Nunca debe
// lanzar ni volver a llamar console.error (evita recursión).
//
// Si hay un request HTTP en curso, el error se encola (bufferError) en vez
// de escribirse ya -- todavía no se sabe el statusCode real de la
// respuesta. requestTimingMiddleware lo vacía con flushBufferedErrors() en
// cuanto el response termina. Si no hay request activo (ej. un error
// dentro de un job en background como fullvectorRetry), se escribe de
// inmediato porque nunca habrá un "finish" que lo dispare.
function captureError(args) {
  try {
    const { err, message } = pickErrorAndMessage(args);
    const entry = { message, stack: err?.stack ? String(err.stack).slice(0, 2000) : null };
    if (!bufferError(entry)) {
      persist({ ...entry, method: null, path: null, statusCode: null, userId: null, tenantId: null, ip: null, userAgent: null, origin: null });
    }
  } catch {
    // intencional: no-op
  }
}

function flushBufferedErrors(statusCode) {
  try {
    const ctx = getRequestContext();
    const errors = takeBufferedErrors();
    for (const entry of errors) {
      persist({
        ...entry,
        method: ctx?.method ?? null,
        path: ctx?.path ?? null,
        statusCode,
        userId: ctx?.userId ?? null,
        tenantId: ctx?.tenantId ?? null,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ? String(ctx.userAgent).slice(0, 300) : null,
        origin: ctx?.origin ?? null,
      });
    }
  } catch {
    // intencional: no-op
  }
}

module.exports = { captureError, flushBufferedErrors };
