// Diagnostico de ventas que no llegaron a FullVector. Solo lee.
//
//   DATABASE_URL="<url de produccion>" node scripts/diagnostico-fullvector.js
//
// Agrupa las ventas no sincronizadas por la causa que quedo escrita en
// `fullvectorError` al momento del intento, y separa el caso mudo: las que
// nunca se intentaron porque la integracion estaba apagada (sin
// FULLVECTOR_API_URL / _SERVICE_EMAIL / _SERVICE_PASSWORD en el entorno).
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function causa(venta) {
  if (venta.fullvectorSyncStatus === "PENDING" && venta.fullvectorAttempts === 0 && !venta.fullvectorError) {
    return "NUNCA SE INTENTO (integracion apagada: faltan las FULLVECTOR_* en el entorno)";
  }
  return venta.fullvectorError || "(sin mensaje)";
}

(async () => {
  const totales = await prisma.venta.groupBy({ by: ["fullvectorSyncStatus"], _count: true });
  console.log("Ventas por estado de sincronizacion");
  for (const t of totales) console.log(`  ${t.fullvectorSyncStatus}: ${t._count}`);

  const pendientes = await prisma.venta.findMany({
    where: { NOT: { fullvectorSyncStatus: "SYNCED" } },
    select: {
      id: true, folio: true, fecha: true, monto: true, leadId: true,
      fullvectorSyncStatus: true, fullvectorAttempts: true, fullvectorError: true,
    },
    orderBy: { fecha: "desc" },
  });

  if (pendientes.length === 0) {
    console.log("\nNo hay ventas sin sincronizar.");
  } else {
    const porCausa = new Map();
    for (const v of pendientes) {
      const k = causa(v);
      if (!porCausa.has(k)) porCausa.set(k, []);
      porCausa.get(k).push(v);
    }

    console.log(`\n${pendientes.length} ventas sin llegar a FullVector, por causa:\n`);
    for (const [k, ventas] of [...porCausa].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`[${ventas.length}] ${k}`);
      for (const v of ventas.slice(0, 10)) {
        console.log(
          `     venta #${v.id} folio=${v.folio} lead=${v.leadId} ${v.fecha.toISOString().slice(0, 10)}` +
          ` $${v.monto} ${v.fullvectorSyncStatus} intentos=${v.fullvectorAttempts}`,
        );
      }
      if (ventas.length > 10) console.log(`     ...y ${ventas.length - 10} mas`);
      console.log("");
    }
  }

  // Una venta marcada SYNCED por un 409 (duplicada) queda sin orderId: la
  // orden existe en FullVector pero no sabemos con que id, asi que no se
  // puede rastrear desde aqui.
  const sinOrderId = await prisma.venta.count({
    where: { fullvectorSyncStatus: "SYNCED", fullvectorOrderId: null },
  });
  if (sinOrderId > 0) {
    console.log(`Aviso: ${sinOrderId} ventas estan SYNCED pero sin fullvectorOrderId`);
    console.log("(respuesta 409 duplicada, o un 200 sin id en el cuerpo): revisar a mano en FullVector.\n");
  }

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error("Fallo el diagnostico:", err.message);
  await prisma.$disconnect();
  process.exit(1);
});
