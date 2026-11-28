// El tipo de cambio dólar -> peso, consultado una vez al día.
//
// Twilio cobra en dólares y la recarga es en pesos: el gasto en pesos
// depende del tipo de cambio, que se mueve. No se captura a mano -- un
// valor que nadie actualiza se queda viejo sin avisar --, se consulta solo.
//
// Fuentes públicas sin llave, en orden: open.er-api.com (se actualiza a
// diario) y, si falla, Frankfurter (datos del Banco Central Europeo). Se
// guarda el último valor con su fecha y fuente; si ninguna responde, se
// sigue usando el último que se tenga.
const prisma = require("./prisma");

const CLAVE = "tipoCambioUsdMxn";
// Sólo hasta la primera consulta exitosa.
const RESPALDO = 19.5;
const INTERVALO_MS = 6 * 60 * 60 * 1000;
const VIGENCIA_MS = 20 * 60 * 60 * 1000;

const FUENTES = [
  {
    nombre: "open.er-api.com",
    url: "https://open.er-api.com/v6/latest/USD",
    leer: (d) => (d?.result === "success" ? d.rates?.MXN : null),
  },
  {
    nombre: "Frankfurter (Banco Central Europeo)",
    url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=MXN",
    leer: (d) => d?.rates?.MXN,
  },
];

async function leerGuardado() {
  // Global, no por espacio: el dólar vale lo mismo para todos.
  const fila = await prisma.appSetting.findFirst({ where: { tenantId: null, key: CLAVE } });
  if (!fila) return { fila: null, dato: null };
  try {
    return { fila, dato: JSON.parse(fila.value) };
  } catch {
    return { fila, dato: null };
  }
}

// { valor, consultadoAt, fuente } — el último guardado, o el de respaldo.
async function obtenerTipoCambio() {
  const { dato } = await leerGuardado();
  if (dato?.valor) return dato;
  return { valor: RESPALDO, consultadoAt: null, fuente: "valor de respaldo (aún no se consulta)" };
}

async function actualizarTipoCambio({ forzar = false } = {}) {
  const { fila, dato } = await leerGuardado();
  if (!forzar && dato?.consultadoAt && Date.now() - new Date(dato.consultadoAt).getTime() < VIGENCIA_MS) return dato;

  for (const f of FUENTES) {
    try {
      const resp = await fetch(f.url, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) continue;
      const valor = Number(f.leer(await resp.json()));
      // Un valor absurdo (API rota) no se guarda.
      if (!Number.isFinite(valor) || valor < 5 || valor > 60) continue;
      const nuevo = { valor: Math.round(valor * 10000) / 10000, consultadoAt: new Date().toISOString(), fuente: f.nombre };
      const value = JSON.stringify(nuevo);
      if (fila) await prisma.appSetting.update({ where: { id: fila.id }, data: { value } });
      else await prisma.appSetting.create({ data: { tenantId: null, key: CLAVE, value } });
      console.log(`tipo de cambio: ${nuevo.valor} MXN por US$ (${f.nombre})`);
      return nuevo;
    } catch (err) {
      console.error("tipo de cambio: fallo", f.nombre, err.message);
    }
  }
  return dato;
}

// Revisa cada 6 horas y consulta si el guardado tiene más de 20: así se
// actualiza una vez al día aunque el servicio se reinicie a cualquier hora.
function startTipoCambioJob() {
  setTimeout(() => {
    actualizarTipoCambio();
    setInterval(actualizarTipoCambio, INTERVALO_MS);
  }, 30 * 1000);
}

module.exports = { obtenerTipoCambio, actualizarTipoCambio, startTipoCambioJob };
