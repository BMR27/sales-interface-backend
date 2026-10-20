const { AsyncLocalStorage } = require("node:async_hooks");

const als = new AsyncLocalStorage();

// Middleware: corre el resto del request dentro del contexto para que
// cualquier console.error disparado en ese request (sin importar qué tan
// profundo esté) pueda etiquetarse con método/ruta/usuario -- ver
// src/lib/errorLog.js. `errors` acumula los console.error de este request
// sin escribir a DB todavía -- se vacían en requestTimingMiddleware cuando
// ya se conoce el statusCode real de la respuesta (ver flushBufferedErrors
// en errorLog.js).
function requestContextMiddleware(req, res, next) {
  als.run({ method: req.method, path: req.path, userId: null, tenantId: null, errors: [] }, next);
}

// Las rutas llaman esto tras pasar authMiddleware, cuando ya hay req.user.
function setRequestUser(userId, tenantId) {
  const store = als.getStore();
  if (store) {
    store.userId = userId;
    store.tenantId = tenantId;
  }
}

function getRequestContext() {
  return als.getStore() || null;
}

// Devuelve true si había un request activo y el error quedó encolado ahí
// (se persistirá con el statusCode real al terminar el request). false si
// no hay contexto (ej. un job en background) -- el llamador debe
// persistirlo de inmediato en ese caso.
function bufferError(entry) {
  const store = als.getStore();
  if (!store) return false;
  store.errors.push(entry);
  return true;
}

function takeBufferedErrors() {
  const store = als.getStore();
  if (!store || store.errors.length === 0) return [];
  const errors = store.errors;
  store.errors = [];
  return errors;
}

module.exports = {
  requestContextMiddleware,
  setRequestUser,
  getRequestContext,
  bufferError,
  takeBufferedErrors,
};
