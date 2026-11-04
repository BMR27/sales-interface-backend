// Que producto manda el proveedor y si coincide con el catalogo.
//
// La pregunta que contesta: cuando un lead entra con un producto que no
// esta en el catalogo, ¿el proveedor lo mando mal, o le cambiamos el
// nombre de este lado sin avisarle?
//
// Desde la pantalla las dos cosas se ven igual -- un lead sin enlazar --
// y se resuelven al reves: una es un reclamo al proveedor, la otra es
// trabajo nuestro. Reclamarle por un nombre que nosotros cambiamos
// quema la relacion sin arreglar nada.
//
// La evidencia es el PAYLOAD CRUDO. Cada lead que entra por la API queda
// guardado tal como llego en incoming_leads.rawPayload, antes de que
// nadie lo interprete. Eso es lo que se le puede enseñar al proveedor: no
// es nuestra lectura de lo que mando, es lo que mando.
//
// Lo que el script NO hace: decidir quien tiene la razon. Pone lado a lado
// lo que llego y lo que hay en el catalogo, con fechas, y eso es lo que
// permite concluir. Si un nombre llevaba meses llegando igual y el
// catalogo cambio despues, el dato lo dice solo.
//
//   node scripts/auditar-productos-proveedor.js
//   node scripts/auditar-productos-proveedor.js --payload   (muestra un
//       ejemplo del JSON crudo de cada variante, para adjuntarlo al correo)
const prisma = require("../src/lib/prisma");
const { normalizar } = require("../src/lib/catalogoProducto");

const VER_PAYLOAD = process.argv.includes("--payload");

const fecha = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "-");

(async () => {
  const [entrantes, catalogo, alias] = await Promise.all([
    prisma.incomingLead.findMany({
      select: {
        product: true, internalSku: true, externalSku: true, category: true,
        createdAt: true, rawPayload: true, tenantId: true,
        apiKey: { select: { label: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.producto.findMany({
      select: { id: true, sku: true, nombre: true, producto: true, activo: true, createdAt: true, tenantId: true },
    }),
    prisma.productoAlias.findMany({ include: { producto: { select: { nombre: true, sku: true } } } }),
  ]);

  if (entrantes.length === 0) {
    console.log("No hay leads recibidos por la API en esta base.");
    await prisma.$disconnect();
    return;
  }

  // Se agrupa por la combinacion exacta que manda el proveedor. Dos
  // variantes del mismo producto (con y sin sku, por ejemplo) son dos
  // filas: justamente lo que interesa ver.
  const variantes = new Map();
  for (const e of entrantes) {
    const clave = `${e.product}||${e.internalSku || ""}||${e.externalSku || ""}`;
    const v = variantes.get(clave) || {
      product: e.product, internalSku: e.internalSku, externalSku: e.externalSku,
      total: 0, primera: e.createdAt, ultima: e.createdAt,
      origen: e.apiKey?.label || "?", ejemplo: e.rawPayload, tenantId: e.tenantId,
    };
    v.total += 1;
    if (e.createdAt < v.primera) v.primera = e.createdAt;
    if (e.createdAt > v.ultima) v.ultima = e.createdAt;
    variantes.set(clave, v);
  }

  console.log("=== CATALOGO ACTUAL ===");
  for (const p of catalogo.sort((a, b) => a.sku.localeCompare(b.sku))) {
    console.log(`  ${p.sku.padEnd(16)} ${p.nombre.padEnd(24)} alta: ${fecha(p.createdAt)}${p.activo ? "" : "  (INACTIVO)"}`);
  }
  if (alias.length) {
    console.log("\n=== ALIAS REGISTRADOS ===");
    for (const a of alias) console.log(`  "${a.alias}" -> ${a.producto.nombre} (${a.producto.sku})`);
  }

  console.log("\n=== LO QUE MANDA EL PROVEEDOR ===\n");

  const filas = [...variantes.values()].sort((a, b) => b.total - a.total);
  const problemas = [];

  for (const v of filas) {
    const delTenant = catalogo.filter((p) => p.tenantId === v.tenantId);
    const porSku = delTenant.find((p) => p.sku === v.internalSku || p.sku === v.externalSku);
    const porNombre = delTenant.filter(
      (p) => normalizar(p.nombre) === normalizar(v.product) || normalizar(p.producto) === normalizar(v.product)
    );
    const porAlias = alias.find(
      (a) => a.tenantId === v.tenantId && a.aliasNorm === normalizar(v.product)
    );

    console.log(`"${v.product}"`);
    console.log(`  sku que manda:  interno=${v.internalSku || "-"}  externo=${v.externalSku || "-"}`);
    console.log(`  leads:          ${v.total}   del ${fecha(v.primera)} al ${fecha(v.ultima)}   (API: ${v.origen})`);

    // --- El veredicto, con su razon ---
    if (porSku && normalizar(porSku.nombre) === normalizar(v.product)) {
      console.log(`  ✓ COINCIDE con ${porSku.nombre} (${porSku.sku}): mismo sku y mismo nombre.`);
    } else if (porSku) {
      console.log(`  ! El SKU ${porSku.sku} existe, pero en el catalogo se llama "${porSku.nombre}".`);
      console.log(`    El proveedor usa el sku correcto con otro nombre -> se le renombro de este lado.`);
      problemas.push({ v, tipo: "nombre distinto, mismo sku", producto: porSku });
    } else if (porNombre.length === 1) {
      console.log(`  ! El NOMBRE coincide con ${porNombre[0].nombre}, pero su sku hoy es ${porNombre[0].sku}`);
      console.log(`    y el proveedor manda ${v.internalSku || v.externalSku}. -> se renumero de este lado.`);
      problemas.push({ v, tipo: "sku distinto, mismo nombre", producto: porNombre[0] });
    } else if (porAlias) {
      console.log(`  ~ No casa con el catalogo, pero hay un ALIAS: -> ${porAlias.producto.nombre} (${porAlias.producto.sku}).`);
      console.log(`    Los leads si se enlazan. El desajuste de fondo sigue ahi.`);
      problemas.push({ v, tipo: "resuelto con alias", producto: porAlias.producto });
    } else {
      console.log(`  ✗ NO COINCIDE con nada del catalogo: ni por sku, ni por nombre, ni por alias.`);
      console.log(`    Este si es un producto que el proveedor manda y nosotros no tenemos.`);
      problemas.push({ v, tipo: "sin coincidencia", producto: null });
    }

    if (VER_PAYLOAD && v.ejemplo) {
      console.log("  payload crudo de ejemplo:");
      console.log(
        JSON.stringify(v.ejemplo, null, 2)
          .split("\n")
          .map((l) => "    " + l)
          .join("\n")
      );
    }
    console.log();
  }

  // --- Lectura ---
  //
  // Lo que decide de quien es el desajuste es la CRONOLOGIA: si el
  // proveedor lleva mandando el mismo nombre desde antes de que el
  // producto se diera de alta con el nombre nuevo, el que cambio fue el
  // catalogo.
  if (problemas.length === 0) {
    console.log("Todo lo que manda el proveedor coincide con el catalogo.");
  } else {
    console.log("=== DESAJUSTES ===\n");
    for (const p of problemas) {
      const linea = `"${p.v.product}" (${p.v.total} leads, desde ${fecha(p.v.primera)}): ${p.tipo}`;
      console.log(`  ${linea}`);
      if (p.producto) {
        const antes = new Date(p.v.primera) < new Date(p.producto.createdAt);
        console.log(
          `     catalogo: "${p.producto.nombre}" (${p.producto.sku}), dado de alta el ${fecha(p.producto.createdAt)}` +
            (antes
              ? "  <- el proveedor YA mandaba este nombre antes de esa alta"
              : "")
        );
      }
    }
    console.log(
      "\nComo leerlo: si el proveedor venia mandando el mismo nombre y sku desde antes\n" +
        "de que el producto del catalogo se diera de alta con el nombre nuevo, el cambio\n" +
        "fue de este lado y no hay nada que reclamarle -- hay que avisarle el nombre nuevo\n" +
        "o registrar el alias. Corre con --payload para adjuntar la evidencia cruda."
    );
  }

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
