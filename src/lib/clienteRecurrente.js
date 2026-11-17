// Clientes que ya compraron antes.
//
// Para que la vendedora lo sepa ANTES de empezar a convencer: a alguien
// que ya compro y volvio a dejar sus datos no hay que venderle la idea,
// hay que tomarle el pedido. Es informacion que cambia la llamada entera y
// que hoy solo se descubre a la mitad, si acaso.
//
// Que cuenta como recurrente: el MISMO TELEFONO tiene al menos una venta
// anterior en otro lead. No basta con haber entrado antes -- eso es un
// duplicado, que es otra cosa y ya tiene su pantalla. La diferencia
// importa: un duplicado es un cobro de mas del proveedor, un recurrente es
// un cliente bueno.
//
// La comparacion es por los ultimos 10 digitos, la misma regla que usa la
// lista de bloqueados: el mismo numero llega escrito de varias formas y
// como texto no casaria consigo mismo.
const { claveTelefono } = require("./numeroBloqueado");

// Devuelve un Set con los ids de los leads cuyo cliente ya compro antes.
//
// Una sola consulta para toda la lista, no una por lead: esto se llama al
// pintar el feed y con 100 leads serian 100 viajes a la base.
//
// Nunca lanza: si falla, nadie sale marcado. Perder un distintivo es
// molesto; tumbar el feed de la vendedora, no.
async function marcarRecurrentes(prisma, leads, tenantId) {
  const vacio = new Set();
  if (!Array.isArray(leads) || leads.length === 0 || !tenantId) return vacio;

  try {
    const claves = new Map();
    for (const l of leads) {
      const c = claveTelefono(l.telefono);
      if (!c) continue;
      if (!claves.has(c)) claves.set(c, []);
      claves.get(c).push(l.id);
    }
    if (claves.size === 0) return vacio;

    // Las ventas de esos telefonos. Se agrupa en SQL por la misma clave de
    // 10 digitos para que coincida con lo que se calculo arriba.
    const filas = await prisma.$queryRawUnsafe(
      `SELECT right(regexp_replace(l.telefono, '[^0-9]', '', 'g'), 10) AS clave,
              array_agg(DISTINCT l.id) AS ids
         FROM leads l
         JOIN ventas v ON v."leadId" = l.id AND v.cancelada = false
        WHERE l."tenantId" = $1
          AND right(regexp_replace(l.telefono, '[^0-9]', '', 'g'), 10) = ANY($2::text[])
        GROUP BY 1`,
      tenantId,
      [...claves.keys()]
    );

    const recurrentes = new Set();
    for (const f of filas) {
      const idsDeLaLista = claves.get(f.clave) || [];
      const idsConVenta = new Set((f.ids || []).map(Number));
      for (const id of idsDeLaLista) {
        // El lead NO se marca por su propia venta: un lead vendido no es
        // "un cliente que ya compro antes", es la compra misma. Se marca
        // solo si hay una venta en OTRO lead del mismo telefono.
        const otras = [...idsConVenta].filter((x) => x !== id);
        if (otras.length > 0) recurrentes.add(id);
      }
    }
    return recurrentes;
  } catch (err) {
    console.error("no se pudo calcular clientes recurrentes", err);
    return vacio;
  }
}

module.exports = { marcarRecurrentes };
