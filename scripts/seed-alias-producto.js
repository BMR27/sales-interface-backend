// Da de alta los nombres con que los proveedores mandan cada producto.
//
// El proveedor manda "Prosta Vital Men" donde el catalogo dice "Vital Men
// Balance". No son dos formas de escribir lo mismo -- son dos nombres
// comerciales de la misma cosa, y no hay regla que saque uno del otro. Sin
// el alias el lead nace con productoId NULL y la vendedora abre la llamada
// sin precio, sin speech y sin promociones, con un aviso de que el producto
// no esta en el catalogo cuando si esta.
//
// Para agregar uno nuevo: agregalo a ALIAS de abajo y vuelve a correr el
// script. Es idempotente -- un alias que ya existe apuntando al mismo
// producto no se toca.
//
// El producto se busca por SKU si lo pones, y si no por nombre exacto. El
// SKU es mas seguro: no cambia cuando alguien edita el nombre del catalogo.
//
//   node scripts/seed-alias-producto.js           (simulacion)
//   node scripts/seed-alias-producto.js --aplicar (escribe)
//
// Despues de aplicar, para enlazar los leads que ya habian nacido huerfanos:
//
//   node scripts/backfill-producto-catalogo.js --aplicar
const prisma = require("../src/lib/prisma");
const { normalizar } = require("../src/lib/catalogoProducto");

// alias: como lo manda el proveedor. sku/nombre: como esta en el catalogo.
const ALIAS = [
  // El proveedor manda "Prosta Vital Men" con el sku PS-SU-MEN-001; el
  // catalogo renombro el producto a "Vital Men Balance" y le cambio el sku
  // a PS-SU-MEN-002, asi que no coincide ni por nombre ni por sku y los
  // leads caen huerfanos.
  //
  // Se apunta al catalogo por sku Y por nombre: el sku identifica mejor,
  // pero el nombre salva el caso de un entorno donde todavia no se haya
  // renumerado. Si el catalogo del tenant todavia se llama igual que el
  // alias, el script lo detecta y no registra nada: ahi el nombre exacto
  // ya resuelve solo y el alias nunca se usaria.
  { alias: "Prosta Vital Men", sku: "PS-SU-MEN-002", nombre: "Vital Men Balance" },
];

const APLICAR = process.argv.includes("--aplicar");

(async () => {
  const tenants = await prisma.tenant.findMany({ select: { id: true, razonSocial: true } });

  let creados = 0;
  let yaEstaban = 0;
  const problemas = [];

  for (const t of tenants) {
    for (const entrada of ALIAS) {
      const aliasNorm = normalizar(entrada.alias);
      if (!aliasNorm) {
        problemas.push(`alias vacio en la lista: ${JSON.stringify(entrada)}`);
        continue;
      }

      // El producto del catalogo al que apunta este alias. Si el tenant no
      // lo vende, no es un error: simplemente no hay nada que registrar.
      // Primero por sku, que es el identificador; el nombre queda de
      // respaldo para los entornos donde el catalogo aun no se renumero.
      const producto =
        (entrada.sku
          ? await prisma.producto.findFirst({ where: { tenantId: t.id, sku: entrada.sku } })
          : null) ||
        (entrada.nombre
          ? await prisma.producto.findFirst({ where: { tenantId: t.id, nombre: entrada.nombre } })
          : null);

      if (!producto) continue;

      // El catalogo de este tenant todavia se llama igual que el alias:
      // el paso del nombre exacto ya resuelve el enlace solo y el alias
      // nunca llegaria a consultarse. Registrarlo seria ruido.
      if (normalizar(producto.nombre) === aliasNorm || normalizar(producto.producto) === aliasNorm) {
        console.log(
          `  de mas: [${t.razonSocial}] el catalogo ya se llama "${producto.nombre}" (sku ${producto.sku}); ` +
            `el nombre exacto basta`
        );
        yaEstaban += 1;
        continue;
      }

      // Un alias que ya apunta a OTRO producto es una contradiccion entre
      // lo que dice esta lista y lo que alguien registro antes. No se pisa
      // en silencio: se reporta para que lo resuelva una persona.
      const existente = await prisma.productoAlias.findUnique({
        where: { tenantId_aliasNorm: { tenantId: t.id, aliasNorm } },
      });

      if (existente) {
        if (existente.productoId === producto.id) {
          yaEstaban += 1;
        } else {
          problemas.push(
            `[${t.razonSocial}] "${entrada.alias}" ya apunta al producto ${existente.productoId}, ` +
              `no a ${producto.nombre} (${producto.id}). Sin tocar.`
          );
        }
        continue;
      }

      // Un alias que choca con el nombre de un producto del catalogo nunca
      // se usaria: el paso del nombre exacto gana antes de llegar al alias.
      const choca = await prisma.producto.findFirst({
        where: { tenantId: t.id, activo: true, nombre: entrada.alias },
      });
      if (choca && choca.id !== producto.id) {
        problemas.push(
          `[${t.razonSocial}] "${entrada.alias}" ya es el nombre del producto ${choca.nombre} ` +
            `(${choca.id}); el alias nunca se usaria. Sin registrar.`
        );
        continue;
      }

      if (APLICAR) {
        await prisma.productoAlias.create({
          data: { tenantId: t.id, productoId: producto.id, alias: entrada.alias.trim(), aliasNorm },
        });
      }
      console.log(
        `  ${APLICAR ? "registrado" : "se registraria"}: [${t.razonSocial}] ` +
          `"${entrada.alias}" -> ${producto.nombre} (sku ${producto.sku})`
      );
      creados += 1;
    }
  }

  if (problemas.length > 0) {
    console.log(`\n${problemas.length} para revisar a mano:`);
    for (const p of problemas) console.log(`  ${p}`);
  }

  console.log(
    `\n${APLICAR ? "Registrados" : "Se registrarian"}: ${creados}. Ya estaban: ${yaEstaban}. Para revisar: ${problemas.length}.`
  );
  if (!APLICAR && creados > 0) console.log("Simulacion. Corre con --aplicar para escribir.");
  if (APLICAR && creados > 0) {
    console.log("Ahora: node scripts/backfill-producto-catalogo.js --aplicar");
  }
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
