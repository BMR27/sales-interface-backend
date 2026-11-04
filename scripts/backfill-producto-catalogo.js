// Enlaza con el catalogo los leads que nacieron sin `productoId`.
//
// Hasta el arreglo de src/lib/catalogoProducto.js el enlace se intentaba
// solo por internalSku, asi que todo lead sin SKU quedo huerfano: su panel
// de llamada abria sin speech, sin precio y sin promociones aunque el
// producto estuviera en el catalogo con el mismo nombre.
//
// Solo toca leads con productoId NULL y solo cuando hay UNA coincidencia
// exacta. Los que no se puedan resolver se quedan como estan y se listan al
// final, para capturarlos a mano.
//
//   node scripts/backfill-producto-catalogo.js           (simulacion)
//   node scripts/backfill-producto-catalogo.js --aplicar (escribe)
const prisma = require("../src/lib/prisma");
const { resolverProducto } = require("../src/lib/catalogoProducto");

const APLICAR = process.argv.includes("--aplicar");

(async () => {
  const huerfanos = await prisma.lead.findMany({
    where: { productoId: null },
    select: { id: true, folioPS: true, producto: true, internalSku: true, externalSku: true, tenantId: true },
  });

  console.log(`${huerfanos.length} leads sin enlazar al catalogo\n`);

  let enlazados = 0;
  const sinResolver = [];

  for (const l of huerfanos) {
    const prod = await resolverProducto({
      tenantId: l.tenantId,
      internalSku: l.internalSku,
      externalSku: l.externalSku,
      nombre: l.producto,
    });

    if (!prod) {
      sinResolver.push(l);
      continue;
    }

    if (APLICAR) {
      await prisma.lead.update({ where: { id: l.id }, data: { productoId: prod.id } });
    }
    console.log(`  ${APLICAR ? "enlazado" : "se enlazaria"}: ${l.folioPS ?? l.id} "${l.producto}" -> ${prod.nombre} (sku ${prod.sku})`);
    enlazados += 1;
  }

  if (sinResolver.length > 0) {
    console.log(`\n${sinResolver.length} sin coincidencia en el catalogo -- hay que elegirlos a mano:`);
    for (const l of sinResolver) console.log(`  ${l.folioPS ?? l.id}: "${l.producto}"`);
  }

  console.log(`\n${APLICAR ? "Enlazados" : "Se enlazarian"}: ${enlazados}. Sin resolver: ${sinResolver.length}.`);
  if (!APLICAR && enlazados > 0) console.log("Simulacion. Corre con --aplicar para escribir.");
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
