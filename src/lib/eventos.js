// Avisos en vivo hacia las pantallas abiertas.
//
// Sin esto, el tablero del administrador mostraba lo que era cierto cuando
// cargo la pagina: la coordinadora repartia 25 leads y el admin seguia
// viendo la cola intacta hasta que recargaba a mano. Lo mismo entre la
// cola de la coordinadora y lo que acaba de cerrar una vendedora.
//
// Es un bus en memoria, a proposito: no hay cola de mensajes ni historial.
// Un evento solo dice "esto cambio, vuelve a pedir los datos" y la pantalla
// recarga por su cuenta. Si un aviso se pierde -- reconexion, pestaña
// dormida -- la siguiente carga trae la verdad igual.
//
// OJO si algun dia corren mas de una instancia del backend: cada proceso
// tiene su propio registro, asi que un cambio hecho en la instancia A no
// llegaria a las pantallas conectadas a la B. Ese dia esto necesita un
// Redis en medio (o pasar a polling); mientras sea un proceso, sobra.

// tenantId -> Set de respuestas HTTP con la conexion abierta.
const clientesPorTenant = new Map();

function suscribir(tenantId, res) {
  if (!clientesPorTenant.has(tenantId)) clientesPorTenant.set(tenantId, new Set());
  clientesPorTenant.get(tenantId).add(res);

  return () => {
    const clientes = clientesPorTenant.get(tenantId);
    if (!clientes) return;
    clientes.delete(res);
    if (clientes.size === 0) clientesPorTenant.delete(tenantId);
  };
}

// Avisa a todas las pantallas de esa empresa que algo cambio.
//
// Nunca lanza: va colgado de rutas que ya hicieron su trabajo, y que un
// aviso falle no puede tumbar una asignacion ni una venta que ya se
// guardo.
function emitir(tenantId, tipo, datos = {}) {
  try {
    const clientes = clientesPorTenant.get(tenantId);
    if (!clientes || clientes.size === 0) return;

    const payload = JSON.stringify({ tipo, datos, en: new Date().toISOString() });
    for (const res of clientes) {
      try {
        res.write(`data: ${payload}\n\n`);
      } catch {
        // Conexion ya rota: la limpia su propio 'close'.
      }
    }
  } catch (err) {
    console.error("no se pudo emitir el evento", tipo, err);
  }
}

function totalConectados() {
  let total = 0;
  for (const clientes of clientesPorTenant.values()) total += clientes.size;
  return total;
}

module.exports = { suscribir, emitir, totalConectados };
