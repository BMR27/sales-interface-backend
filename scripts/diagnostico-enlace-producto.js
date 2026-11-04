// Por que este lead abre la llamada diciendo que su producto no esta en el
// catalogo.
//
// El aviso del panel ("«X» no coincide con ningun producto del catalogo")
// sale cuando el lead tiene productoId NULL. Las causas son varias y desde
// la pantalla no se distinguen:
//
//   - el lead nacio antes de que existiera el enlace por nombre y nadie
//     corrio el backfill
//   - el proveedor lo manda con otro nombre comercial -> falta un alias
//   - el producto esta inactivo, o es de otro tenant
//   - hay dos productos con el mismo nombre y se dejo sin enlazar aposta
//
// Este script dice cual de las cuatro es, sin escribir nada.
//
//   node scripts/diagnostico-enlace-producto.js PS-00123
//   node scripts/diagnostico-enlace-producto.js "Prosta Vital Men"
const prisma = require("../src/lib/prisma");
const { resolverProducto, normalizar } = require("../src/lib/catalogoProducto");

const BUSCADO = process.argv[2];

(async () => {
  if (!BUSCADO) {
    console.log('Falta el folio o el nombre del producto. Ej: node scripts/diagnostico-enlace-producto.js "Prosta Vital Men"');
    await prisma.$disconnect();
    return;
  }

  const leads = await prisma.lead.findMany({
    where: {
      OR: [{ folioPS: BUSCADO }, { producto: { contains: BUSCADO, mode: "insensitive" } }],
    },
    select: {
      id: true, folioPS: true, producto: true, productoId: true,
      internalSku: true, externalSku: true, tenantId: true, createdAt: true,
    },
    orderBy: { id: "desc" },
    take: 20,
  });

  if (leads.length === 0) {
    console.log(`Ningun lead con folio o producto "${BUSCADO}".`);
    await prisma.$disconnect();
    return;
  }

  console.log(`${leads.length} lead(s):\n`);

  for (const l of leads) {
    const etiqueta = `${l.folioPS ?? l.id} "${l.producto}"`;

    if (l.productoId) {
      const prod = await prisma.producto.findUnique({ where: { id: l.productoId } });
      console.log(`  ${etiqueta}: ENLAZADO a ${prod?.nombre} (sku ${prod?.sku}). El panel no deberia avisar nada.`);
      continue;
    }

    // Sin enlazar. Se vuelve a correr el resolvedor para ver si HOY si
    // podria enlazarse: si puede, el lead solo necesita el backfill.
    const ahora = await resolverProducto({
      tenantId: l.tenantId,
      internalSku: l.internalSku,
      externalSku: l.externalSku,
      nombre: l.producto,
    });

    if (ahora) {
      console.log(
        `  ${etiqueta}: SIN ENLAZAR, pero hoy resolveria a ${ahora.nombre} (sku ${ahora.sku}).\n` +
          `      -> es un lead viejo. Corre: node scripts/backfill-producto-catalogo.js --aplicar`
      );
      continue;
    }

    // No resuelve. Se dice exactamente que se encontro para que la causa
    // quede a la vista.
    const buscado = normalizar(l.producto);
    const delTenant = await prisma.producto.findMany({
      where: { tenantId: l.tenantId },
      select: { id: true, sku: true, nombre: true, producto: true, activo: true },
    });
    const porNombre = delTenant.filter(
      (p) => normalizar(p.nombre) === buscado || normalizar(p.producto) === buscado
    );
    const alias = await prisma.productoAlias.findUnique({
      where: { tenantId_aliasNorm: { tenantId: l.tenantId, aliasNorm: buscado } },
      include: { producto: true },
    });

    console.log(`  ${etiqueta}: SIN ENLAZAR y hoy tampoco resuelve.`);
    console.log(`      sku del proveedor: interno=${l.internalSku ?? "-"} externo=${l.externalSku ?? "-"}`);
    console.log(`      nombre normalizado: "${buscado}"`);

    if (porNombre.length === 0 && !alias) {
      console.log(`      -> ningun producto del catalogo se llama asi y no hay alias registrado.`);
      console.log(`         Si es un producto que SI vendes con otro nombre, agregalo a`);
      console.log(`         scripts/seed-alias-producto.js y corre ese script.`);
      const parecidos = delTenant.filter((p) => {
        const n = normalizar(p.nombre);
        return buscado.split(" ").some((palabra) => palabra.length > 3 && n.includes(palabra));
      });
      if (parecidos.length > 0) {
        console.log(`         Productos del catalogo que comparten alguna palabra (solo como pista,`);
        console.log(`         el enlace NO se hace por parecido):`);
        for (const p of parecidos) console.log(`           ${p.nombre} (sku ${p.sku})`);
      }
    } else if (porNombre.length > 1) {
      console.log(`      -> ${porNombre.length} productos del catalogo se llaman igual, por eso se dejo sin enlazar:`);
      for (const p of porNombre) console.log(`           ${p.nombre} (sku ${p.sku}, id ${p.id})`);
      console.log(`         Hay que dejar uno solo con ese nombre.`);
    } else if (porNombre.length === 1 && !porNombre[0].activo) {
      console.log(`      -> ${porNombre[0].nombre} (sku ${porNombre[0].sku}) existe pero esta INACTIVO.`);
      console.log(`         Reactivalo en el catalogo si todavia se vende.`);
    } else if (alias && !alias.producto?.activo) {
      console.log(`      -> hay alias a ${alias.producto?.nombre}, pero ese producto esta INACTIVO.`);
    }
  }

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
