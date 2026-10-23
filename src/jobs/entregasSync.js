// La entrega la confirma FullVector, no nosotros: este tick pregunta por las
// ordenes que ya llegaron a SUCCESSFUL_DELIVERY (o fallaron) y mueve la venta
// de este lado, recalculando la comision de la quincena afectada.
//
// Corre cada 15 min: una entrega no es un evento de segundos y la consulta
// pagina sobre todas las ordenes del cliente.
const { isEnabled, sincronizarEntregas } = require("../lib/fullvector");

const INTERVAL_MS = 15 * 60 * 1000;

function startEntregasSyncJob() {
  if (!isEnabled()) return;

  const tick = async () => {
    try {
      const r = await sincronizarEntregas();
      if (r.entregadas || r.canceladas) {
        console.log(`entregas sincronizadas: ${r.entregadas} entregadas, ${r.canceladas} no exitosas`);
      }
    } catch (err) {
      console.error("fallo la sincronizacion de entregas", err);
    }
  };

  setInterval(tick, INTERVAL_MS);
  // Un primer tick al arrancar, con holgura para no competir con el arranque.
  setTimeout(tick, 60 * 1000);
}

module.exports = { startEntregasSyncJob };
