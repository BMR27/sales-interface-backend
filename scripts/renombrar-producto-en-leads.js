// Cambia el nombre de un producto en los leads que ya entraron.
//
// `lead.producto` guarda el nombre TAL COMO LO MANDÓ el proveedor, y por
// eso se conservaba sin tocar. Pero ese texto es el que la vendedora lee
// en la tarjeta y el que sale en los reportes, así que cuando el catálogo
// renombra un producto el lead sigue diciendo el nombre viejo y las dos
// pantallas se contradicen: el panel muestra "Vital Men Balance" como
// artículo y la tarjeta del mismo lead dice "Prosta Vital Men".
//
// Qué se toca y qué NO:
//
//   leads.producto        SÍ. Es lo que se muestra.
//   incoming_leads        NO. Es la evidencia de lo que mandó el
//                         proveedor, y es con lo que se concilia y se le
//                         reclama. Reescribirla borraría la prueba de que
//                         mandó otro nombre.
//   producto_alias        NO se borra. El proveedor SIGUE mandando el
//                         nombre viejo: sin el alias, los leads que
//                         entren mañana vuelven a quedar sin enlazar.
//
// El texto viejo del producto no se guarda en ningún lado del lead --
// `nombreOriginal` es para el nombre del CLIENTE, no para esto. Por eso
// es un script y no una migración silenciosa: el respaldo de lo que
// decía cada lead sigue estando en incoming_leads, que no se toca.
//
//   node scripts/renombrar-producto-en-leads.js "Prosta Vital Men" "Vital Men Balance"
//   node scripts/renombrar-producto-en-leads.js "Prosta Vital Men" "Vital Men Balance" --aplicar
const prisma = require("../src/lib/prisma");

const DE = process.argv[2];
const A = process.argv[3];
const APLICAR = process.argv.includes("--aplicar");

(async () => {
  if (!DE || !A) {
    console.error('Uso: node scripts/renombrar-producto-en-leads.js "Nombre viejo" "Nombre nuevo" [--aplicar]');
    process.exit(1);
  }

  const afectados = await prisma.lead.findMany({
    where: { producto: DE },
    select: { id: true, folioPS: true, producto: true, productoId: true, tenantId: true },
  });

  console.log(`${afectados.length} leads con producto "${DE}"\n`);
  if (afectados.length === 0) {
    await prisma.$disconnect();
    return;
  }

  // Se comprueba que el nombre nuevo exista en el catálogo. Renombrar a
  // algo que no está dejaría los leads apuntando a un nombre que ninguna
  // pantalla reconoce, que es peor que el desfase que se quiere arreglar.
  const enCatalogo = await prisma.producto.findFirst({ where: { nombre: A } });
  if (!enCatalogo) {
    console.error(`ATENCIÓN: "${A}" no existe en el catálogo. Revisa el nombre antes de aplicar.`);
    if (APLICAR) process.exit(1);
  } else {
    console.log(`En el catálogo: ${enCatalogo.nombre} (sku ${enCatalogo.sku})\n`);
  }

  // Cuántos quedarían apuntando a otro producto del catálogo: es la señal
  // de que el renombre no es un simple cambio de texto.
  const conOtroEnlace = afectados.filter((l) => l.productoId && enCatalogo && l.productoId !== enCatalogo.id);
  if (conOtroEnlace.length > 0) {
    console.log(`AVISO: ${conOtroEnlace.length} de esos leads están enlazados a OTRO producto del catálogo.`);
    console.log("      Se les cambia el texto, pero su enlace no se toca.\n");
  }

  const muestra = afectados.slice(0, 5);
  for (const l of muestra) {
    console.log(`  ${APLICAR ? "cambiado" : "se cambiaría"}: ${l.folioPS ?? l.id}  "${DE}" -> "${A}"`);
  }
  if (afectados.length > muestra.length) {
    console.log(`  ... y ${afectados.length - muestra.length} más`);
  }

  if (APLICAR) {
    const r = await prisma.lead.updateMany({ where: { producto: DE }, data: { producto: A } });
    console.log(`\nActualizados: ${r.count} leads.`);
    console.log("El registro de incoming_leads NO se tocó: es la evidencia de lo que mandó el proveedor.");
    console.log("El alias tampoco: el proveedor sigue mandando el nombre viejo y sin él los leads nuevos no se enlazarían.");
  } else {
    console.log(`\nSimulación. Corre con --aplicar para cambiar ${afectados.length} leads.`);
  }

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
